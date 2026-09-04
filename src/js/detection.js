const SAMPLE_W = 400;

function polygonArea(points){
  let area = 0;
  for (let index = 0; index < points.length; index += 2){
    const next = (index + 2) % points.length;
    area += points[index] * points[next + 1] - points[next] * points[index + 1];
  }
  return Math.abs(area) * 0.5;
}

function documentQuality(points){
  const corners = [];
  for (let index = 0; index < points.length; index += 2) corners.push({ x: points[index], y: points[index + 1] });
  let quality = 1;
  for (let index = 0; index < corners.length; index++){
    const previous = corners[(index + corners.length - 1) % corners.length];
    const current = corners[index];
    const next = corners[(index + 1) % corners.length];
    const first = { x: previous.x - current.x, y: previous.y - current.y };
    const second = { x: next.x - current.x, y: next.y - current.y };
    const denominator = Math.hypot(first.x, first.y) * Math.hypot(second.x, second.y);
    if (!denominator) return 0;
    const cosine = Math.abs((first.x * second.x + first.y * second.y) / denominator);
    quality *= Math.max(0, 1 - cosine * 1.8);
  }
  return quality;
}

function hasFrameClearance(points, width, height){
  const margin = Math.min(width, height) * 0.02;
  for (let index = 0; index < points.length; index += 2){
    if (points[index] <= margin || points[index] >= width - margin || points[index + 1] <= margin || points[index + 1] >= height - margin) return false;
  }
  return true;
}

function contourToQuadPoints(contour){
  const hull = new cv.Mat();
  cv.convexHull(contour, hull);
  const perimeter = cv.arcLength(hull, true);
  let points = null;
  for (let factor = 1; factor <= 15 && !points; factor++){
    const approximation = new cv.Mat();
    cv.approxPolyDP(hull, approximation, 0.01 * factor * perimeter, true);
    if (approximation.rows === 4){
      points = [];
      for (let index = 0; index < 4; index++) points.push(approximation.data32S[index * 2], approximation.data32S[index * 2 + 1]);
    }
    approximation.delete();
  }
  if (!points){
    const rect = cv.minAreaRect(hull);
    const angle = rect.angle * Math.PI / 180;
    const b = Math.cos(angle) * 0.5, a = Math.sin(angle) * 0.5;
    const { x: cx, y: cy } = rect.center, { width, height } = rect.size;
    const corners = [
      { x: cx - a * height - b * width, y: cy + b * height - a * width },
      { x: cx + a * height - b * width, y: cy - b * height - a * width }
    ];
    corners.push({ x: 2 * cx - corners[0].x, y: 2 * cy - corners[0].y }, { x: 2 * cx - corners[1].x, y: 2 * cy - corners[1].y });
    points = corners.flatMap(point => [point.x, point.y]);
  }
  hull.delete();
  return points;
}

export function findDocumentQuad(mat){
  const gray = new cv.Mat(), blurred = new cv.Mat();
  cv.cvtColor(mat, gray, cv.COLOR_RGBA2GRAY);
  cv.GaussianBlur(gray, blurred, new cv.Size(5, 5), 0);
  const minArea = mat.rows * mat.cols * 0.10, maxArea = mat.rows * mat.cols * 0.96;
  let best = null, bestScore = 0;
  const consider = contour => {
    const area = Math.abs(cv.contourArea(contour));
    if (area < minArea || area > maxArea) return;
    const points = contourToQuadPoints(contour);
    if (!points) return;
    const quadArea = polygonArea(points), quality = documentQuality(points);
    if (quadArea < minArea || quadArea > maxArea || quality < 0.12 || !hasFrameClearance(points, mat.cols, mat.rows)) return;
    const mask = cv.Mat.zeros(mat.rows, mat.cols, cv.CV_8UC1);
    const pointsMat = cv.matFromArray(4, 1, cv.CV_32SC2, points), vector = new cv.MatVector();
    vector.push_back(pointsMat);
    cv.fillPoly(mask, vector, new cv.Scalar(255));
    const fillRatio = Math.min(1, quadArea / area);
    const brightness = cv.mean(gray, mask)[0] / 255;
    const score = quadArea * quality * fillRatio * (0.4 + 0.6 * brightness);
    if (score > bestScore){ bestScore = score; best = points; }
    mask.delete(); pointsMat.delete(); vector.delete();
  };
  const binary = new cv.Mat();
  cv.threshold(blurred, binary, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU);
  const kernel = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(7, 7)), closed = new cv.Mat();
  cv.morphologyEx(binary, closed, cv.MORPH_CLOSE, kernel);
  const contours = new cv.MatVector(), hierarchy = new cv.Mat();
  cv.findContours(closed, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
  for (let index = 0; index < contours.size(); index++){ const contour = contours.get(index); consider(contour); contour.delete(); }
  binary.delete(); kernel.delete(); closed.delete(); contours.delete(); hierarchy.delete();
  const edges = new cv.Mat(), dilated = new cv.Mat(), edgeKernel = cv.Mat.ones(3, 3, cv.CV_8U);
  cv.Canny(blurred, edges, 50, 150); cv.dilate(edges, dilated, edgeKernel, new cv.Point(-1, -1), 2);
  const edgeContours = new cv.MatVector(), edgeHierarchy = new cv.Mat();
  cv.findContours(dilated, edgeContours, edgeHierarchy, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);
  for (let index = 0; index < edgeContours.size(); index++){ const contour = edgeContours.get(index); consider(contour); contour.delete(); }
  edges.delete(); dilated.delete(); edgeKernel.delete(); edgeContours.delete(); edgeHierarchy.delete();
  gray.delete(); blurred.delete();
  return best;
}

export function orderQuad(flat){
  const points = [[flat[0],flat[1]],[flat[2],flat[3]],[flat[4],flat[5]],[flat[6],flat[7]]];
  const center = points.reduce((sum, point) => ({ x:sum.x + point[0] / 4, y:sum.y + point[1] / 4 }), { x:0, y:0 });
  points.sort((first, second) => Math.atan2(first[1] - center.y, first[0] - center.x) - Math.atan2(second[1] - center.y, second[0] - center.x));
  const topLeftIndex = points.reduce((best, point, index) => point[0] + point[1] < points[best][0] + points[best][1] ? index : best, 0);
  const ordered = points.slice(topLeftIndex).concat(points.slice(0, topLeftIndex));
  return { tl:{x:ordered[0][0],y:ordered[0][1]}, tr:{x:ordered[1][0],y:ordered[1][1]}, br:{x:ordered[2][0],y:ordered[2][1]}, bl:{x:ordered[3][0],y:ordered[3][1]} };
}

export function detectFrame({ video, sampleCanvas, onDetected }){
  const width = video.videoWidth, height = video.videoHeight, scale = SAMPLE_W / width;
  sampleCanvas.width = SAMPLE_W; sampleCanvas.height = Math.round(height * scale);
  sampleCanvas.getContext("2d").drawImage(video, 0, 0, sampleCanvas.width, sampleCanvas.height);
  let mat;
  try { mat = cv.imread(sampleCanvas); } catch(error){ return; }
  const flat = findDocumentQuad(mat); mat.delete();
  onDetected(flat ? orderQuad(flat.map(value => value / scale)) : null, width, height);
}
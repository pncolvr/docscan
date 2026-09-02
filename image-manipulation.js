export function warpToQuad(mat, quad){
  const { tl, tr, br, bl } = quad;
  const maxWidth = Math.max(Math.hypot(br.x - bl.x, br.y - bl.y), Math.hypot(tr.x - tl.x, tr.y - tl.y));
  const maxHeight = Math.max(Math.hypot(tr.x - br.x, tr.y - br.y), Math.hypot(tl.x - bl.x, tl.y - bl.y));
  const source = cv.matFromArray(4, 1, cv.CV_32FC2, [tl.x,tl.y, tr.x,tr.y, br.x,br.y, bl.x,bl.y]);
  const target = cv.matFromArray(4, 1, cv.CV_32FC2, [0,0, maxWidth,0, maxWidth,maxHeight, 0,maxHeight]);
  const transform = cv.getPerspectiveTransform(source, target), output = new cv.Mat();
  cv.warpPerspective(mat, output, transform, new cv.Size(maxWidth, maxHeight), cv.INTER_LINEAR, cv.BORDER_CONSTANT, new cv.Scalar());
  source.delete(); target.delete(); transform.delete();
  return output;
}

function enhanceColor(mat){
  const blurred = new cv.Mat(), sharp = new cv.Mat();
  cv.GaussianBlur(mat, blurred, new cv.Size(0,0), 3); cv.addWeighted(mat, 1.5, blurred, -0.5, 0, sharp); blurred.delete();
  return sharp;
}

function enhanceBW(mat){
  const gray = new cv.Mat(), thresholded = new cv.Mat(), rgba = new cv.Mat();
  cv.cvtColor(mat, gray, cv.COLOR_RGBA2GRAY); cv.adaptiveThreshold(gray, thresholded, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY, 25, 15); gray.delete();
  cv.cvtColor(thresholded, rgba, cv.COLOR_GRAY2RGBA); thresholded.delete();
  return rgba;
}

export function createImageEditor({ resultCanvas }){
  let correctedMat = null, mode = "enhanced", rotation = 0;
  function displayMat(){
    if (!correctedMat) return null;
    let output = mode === "enhanced" ? enhanceColor(correctedMat) : mode === "bw" ? enhanceBW(correctedMat) : correctedMat.clone();
    if (rotation){ const rotated = new cv.Mat(), rotateMode = rotation === 90 ? cv.ROTATE_90_CLOCKWISE : rotation === 180 ? cv.ROTATE_180 : cv.ROTATE_90_COUNTERCLOCKWISE; cv.rotate(output, rotated, rotateMode); output.delete(); output = rotated; }
    return output;
  }
  function render(){ const output = displayMat(); if (!output) return; resultCanvas.width = output.cols; resultCanvas.height = output.rows; cv.imshow(resultCanvas, output); output.delete(); }
  function setMat(mat){ if (correctedMat) correctedMat.delete(); correctedMat = mat; rotation = 0; render(); }
  async function copy(){
    const canvas = document.createElement("canvas"), output = displayMat(); if (!output) return;
    canvas.width = output.cols; canvas.height = output.rows; cv.imshow(canvas, output); output.delete();
    const blob = await new Promise((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error("Could not create image blob.")), "image/png", 0.96));
    if (!window.isSecureContext) throw new Error("Clipboard copy requires a secure context (HTTPS or localhost).");
    if (navigator.clipboard?.write && typeof ClipboardItem !== "undefined") return navigator.clipboard.write([new ClipboardItem({ [blob.type || "image/png"]: blob })]);
    if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(canvas.toDataURL("image/png"));
    throw new Error("Clipboard API is not available in this browser.");
  }
  function download(){ const canvas = document.createElement("canvas"), output = displayMat(); if (!output) return; canvas.width = output.cols; canvas.height = output.rows; cv.imshow(canvas, output); output.delete(); canvas.toBlob(blob => { const link = document.createElement("a"); link.href = URL.createObjectURL(blob); link.download = `scan-${new Date().toISOString().replace(/[:.]/g,"-")}.jpg`; link.click(); setTimeout(() => URL.revokeObjectURL(link.href), 4000); }, "image/jpeg", 0.92); }
  return { setMat, rotate: () => { if (correctedMat){ rotation = (rotation + 90) % 360; render(); } }, copy, download, setMode: value => { mode = value; render(); } };
}
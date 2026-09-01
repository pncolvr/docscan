(function(){
  "use strict";

  let cvReady = false;
  let stream = null;
  let videoTrack = null;
  let devices = [];
  let deviceIndex = -1;
  let detectLoopId = null;
  let lastQuad = null;
  let capturing = false;
  let correctedMat = null;
  let currentEnhanceMode = "enhanced";
  let rotationDeg = 0;

  const $ = (id) => document.getElementById(id);
  const viewStart = $("view-start"), viewCamera = $("view-camera"), viewResult = $("view-result");
  const video = $("video");
  const sampleCanvas = $("sampleCanvas");
  const overlaySvg = $("overlaySvg");
  const badge = $("badge"), badgeText = $("badgeText");
  const statEdges = $("statEdges"), statRes = $("statRes");
  const deviceSelect = $("deviceSelect");
  const camError = $("camError"), startError = $("startError");
  const resultCanvas = $("resultCanvas");

  window.onOpenCvReady = function(){};

  function waitForCv(cb){
    if (window.cv && window.cv.Mat){ cvReady = true; cb(); return; }
    const t = setInterval(() => {
      if (window.cv && window.cv.Mat){
        clearInterval(t);
        cvReady = true;
        cb();
      }
    }, 150);
    setTimeout(() => { clearInterval(t); if(!cvReady) cb(); }, 15000);
  }

  function supported(){
    const secure = location.protocol === "https:" || location.hostname === "localhost" || location.hostname === "127.0.0.1";
    return { secure, hasMedia: !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia) };
  }

  async function startCamera(constraintsOverride){
    stopCamera();
    camError.classList.remove("show");
    const base = constraintsOverride || { video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false };
    stream = await navigator.mediaDevices.getUserMedia(base);
    video.srcObject = stream;
    await video.play();
    videoTrack = stream.getVideoTracks()[0];

    const all = await navigator.mediaDevices.enumerateDevices();
    devices = all.filter(d => d.kind === "videoinput");
    if (devices.length > 1){
      deviceSelect.classList.remove("hidden");
      deviceSelect.innerHTML = devices.map((d,i) => `<option value="${i}">${d.label || "Camera " + (i+1)}</option>`).join("");
      const settings = videoTrack.getSettings();
      const idx = devices.findIndex(d => d.deviceId === settings.deviceId);
      deviceIndex = idx >= 0 ? idx : 0;
      deviceSelect.value = String(deviceIndex);
    } else {
      deviceSelect.classList.add("hidden");
    }

    statRes.textContent = `${videoTrack.getSettings().width || video.videoWidth}×${videoTrack.getSettings().height || video.videoHeight}`;
    statEdges.textContent = "manual";
    setBadge(false);
    drawOverlay(null, video.videoWidth || 0, video.videoHeight || 0);
    startDetectLoop();
  }

  function stopCamera(){
    stopDetectLoop();
    if (stream){ stream.getTracks().forEach(t => t.stop()); stream = null; }
    videoTrack = null;
  }

  const SAMPLE_W = 400;

  function contourToQuadPoints(cnt){
    let hull = new cv.Mat();
    cv.convexHull(cnt, hull);
    const peri = cv.arcLength(hull, true);
    let quadPts = null;
    for (let k = 1; k <= 15 && !quadPts; k++){
      let approx = new cv.Mat();
      cv.approxPolyDP(hull, approx, 0.01 * k * peri, true);
      if (approx.rows === 4){
        quadPts = [];
        for (let j = 0; j < 4; j++) quadPts.push(approx.data32S[j*2], approx.data32S[j*2+1]);
      }
      approx.delete();
    }
    if (!quadPts){
      const rect = cv.minAreaRect(hull);
      rectCorners(rect.center, rect.size, rect.angle).forEach(p => quadPts ? quadPts.push(p.x, p.y) : (quadPts = [p.x, p.y]));
    }
    hull.delete();
    return quadPts;
  }

  function rectCorners(center, size, angleDeg){
    const angle = angleDeg * Math.PI / 180;
    const b = Math.cos(angle) * 0.5, a = Math.sin(angle) * 0.5;
    const cx = center.x, cy = center.y, w = size.width, h = size.height;
    const p0 = { x: cx - a*h - b*w, y: cy + b*h - a*w };
    const p1 = { x: cx + a*h - b*w, y: cy - b*h - a*w };
    const p2 = { x: 2*cx - p0.x, y: 2*cy - p0.y };
    const p3 = { x: 2*cx - p1.x, y: 2*cy - p1.y };
    return [p0, p1, p2, p3];
  }

  function findDocumentQuad(mat){
    let gray = new cv.Mat(), blurred = new cv.Mat();
    cv.cvtColor(mat, gray, cv.COLOR_RGBA2GRAY);
    cv.GaussianBlur(gray, blurred, new cv.Size(5, 5), 0);

    const frameArea = mat.rows * mat.cols;
    const minArea = frameArea * 0.10;
    const maxArea = frameArea * 0.96;
    let best = null, bestScore = 0;

    function consider(cnt){
      const area = Math.abs(cv.contourArea(cnt));
      if (area < minArea || area > maxArea) return;
      const pts = contourToQuadPoints(cnt);
      if (!pts) return;
      let mask = cv.Mat.zeros(mat.rows, mat.cols, cv.CV_8UC1);
      let ptsMat = cv.matFromArray(4, 1, cv.CV_32SC2, pts);
      let mv = new cv.MatVector(); mv.push_back(ptsMat);
      cv.fillPoly(mask, mv, new cv.Scalar(255));
      const meanVal = cv.mean(gray, mask)[0];
      const score = area * (0.4 + 0.6 * (meanVal / 255));
      if (score > bestScore){ bestScore = score; best = pts; }
      mask.delete(); ptsMat.delete(); mv.delete();
    }

    let bin = new cv.Mat();
    cv.threshold(blurred, bin, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU);
    let kernel = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(7, 7));
    let closed = new cv.Mat();
    cv.morphologyEx(bin, closed, cv.MORPH_CLOSE, kernel);
    let contours1 = new cv.MatVector(), hierarchy1 = new cv.Mat();
    cv.findContours(closed, contours1, hierarchy1, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
    for (let i = 0; i < contours1.size(); i++){ let c = contours1.get(i); consider(c); c.delete(); }
    bin.delete(); kernel.delete(); closed.delete(); contours1.delete(); hierarchy1.delete();

    if (!best){
      let edges = new cv.Mat(), dilated = new cv.Mat();
      cv.Canny(blurred, edges, 50, 150);
      let k2 = cv.Mat.ones(3, 3, cv.CV_8U);
      cv.dilate(edges, dilated, k2, new cv.Point(-1, -1), 2);
      let contours2 = new cv.MatVector(), hierarchy2 = new cv.Mat();
      cv.findContours(dilated, contours2, hierarchy2, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);
      for (let i = 0; i < contours2.size(); i++){ let c = contours2.get(i); consider(c); c.delete(); }
      edges.delete(); dilated.delete(); k2.delete(); contours2.delete(); hierarchy2.delete();
    }

    gray.delete(); blurred.delete();
    return best;
  }

  function orderQuad(flat){
    const pts = [[flat[0],flat[1]],[flat[2],flat[3]],[flat[4],flat[5]],[flat[6],flat[7]]];
    pts.sort((a,b) => (a[0]+a[1]) - (b[0]+b[1]));
    const tl = pts[0], br = pts[3];
    const rest = [pts[1], pts[2]].sort((a,b) => (a[0]-a[1]) - (b[0]-b[1]));
    const bl = rest[0], tr = rest[1];
    return { tl:{x:tl[0],y:tl[1]}, tr:{x:tr[0],y:tr[1]}, br:{x:br[0],y:br[1]}, bl:{x:bl[0],y:bl[1]} };
  }

  function startDetectLoop(){
    stopDetectLoop();
    if (!cvReady) return;
    detectLoopId = setInterval(runDetectTick, 220);
  }

  function stopDetectLoop(){
    if (detectLoopId){ clearInterval(detectLoopId); detectLoopId = null; }
    lastQuad = null;
    setBadge(false);
  }

  function runDetectTick(){
    if (!video.videoWidth || capturing) return;
    const vw = video.videoWidth, vh = video.videoHeight;
    const scale = SAMPLE_W / vw;
    const sw = SAMPLE_W, sh = Math.round(vh * scale);
    sampleCanvas.width = sw; sampleCanvas.height = sh;
    const ctx = sampleCanvas.getContext("2d");
    ctx.drawImage(video, 0, 0, sw, sh);

    let mat;
    try { mat = cv.imread(sampleCanvas); } catch(e){ return; }
    const flat = findDocumentQuad(mat);
    mat.delete();

    if (flat){
      const upscaled = flat.map(v => v / scale);
      const quad = orderQuad(upscaled);
      lastQuad = quad;
      statEdges.textContent = "ready";
      setBadge(true);
      drawOverlay(quad, vw, vh);
    } else {
      lastQuad = null;
      statEdges.textContent = "manual";
      setBadge(false);
      drawOverlay(null, vw, vh);
    }
  }

  function setBadge(found){
    badge.classList.toggle("found", found);
    badgeText.textContent = found ? "document found" : "manual";
  }

  function drawOverlay(quad, vw, vh){
    overlaySvg.setAttribute("viewBox", `0 0 ${vw} ${vh}`);
    if (!quad){ overlaySvg.innerHTML = ""; return; }
    const pts = [quad.tl, quad.tr, quad.br, quad.bl].map(p => `${p.x},${p.y}`).join(" ");
    overlaySvg.innerHTML = `
      <polygon points="${pts}" fill="rgba(232,163,61,0.14)" stroke="var(--accent)" stroke-width="${Math.max(vw*0.006,2)}" stroke-linejoin="round"/>
      ${[quad.tl,quad.tr,quad.br,quad.bl].map(p => `<circle cx="${p.x}" cy="${p.y}" r="${vw*0.012}" fill="var(--accent)"/>`).join("")}
    `;
  }

  async function capturePhoto(){
    if (capturing) return;
    capturing = true;
    $("btnShutter").disabled = true;

    const vw = video.videoWidth, vh = video.videoHeight;
    const full = document.createElement("canvas");
    full.width = vw; full.height = vh;
    full.getContext("2d").drawImage(video, 0, 0, vw, vh);

    let srcMat = cv.imread(full);
    let quad = lastQuad;

    const flatFull = findDocumentQuad(srcMat);
    if (flatFull) quad = orderQuad(flatFull);

    let warped;
    if (quad){
      warped = warpToQuad(srcMat, quad);
    } else {
      warped = srcMat.clone();
    }
    srcMat.delete();

    if (correctedMat) correctedMat.delete();
    correctedMat = warped;
    rotationDeg = 0;

    stopCamera();
    renderResult();
    showView(viewResult);

    capturing = false;
    $("btnShutter").disabled = false;
  }

  function warpToQuad(mat, quad){
    const { tl, tr, br, bl } = quad;
    const widthA = Math.hypot(br.x - bl.x, br.y - bl.y);
    const widthB = Math.hypot(tr.x - tl.x, tr.y - tl.y);
    const heightA = Math.hypot(tr.x - br.x, tr.y - br.y);
    const heightB = Math.hypot(tl.x - bl.x, tl.y - bl.y);
    const maxW = Math.max(widthA, widthB);
    const maxH = Math.max(heightA, heightB);

    const src = cv.matFromArray(4, 1, cv.CV_32FC2, [tl.x,tl.y, tr.x,tr.y, br.x,br.y, bl.x,bl.y]);
    const dst = cv.matFromArray(4, 1, cv.CV_32FC2, [0,0, maxW,0, maxW,maxH, 0,maxH]);
    const M = cv.getPerspectiveTransform(src, dst);
    const out = new cv.Mat();
    cv.warpPerspective(mat, out, M, new cv.Size(maxW, maxH), cv.INTER_LINEAR, cv.BORDER_CONSTANT, new cv.Scalar());
    src.delete(); dst.delete(); M.delete();
    return out;
  }

  function enhanceColor(mat){
    let blurred = new cv.Mat();
    cv.GaussianBlur(mat, blurred, new cv.Size(0,0), 3);
    let sharp = new cv.Mat();
    cv.addWeighted(mat, 1.5, blurred, -0.5, 0, sharp);
    blurred.delete();
    return sharp;
  }

  function enhanceBW(mat){
    let gray = new cv.Mat();
    cv.cvtColor(mat, gray, cv.COLOR_RGBA2GRAY);
    let out = new cv.Mat();
    cv.adaptiveThreshold(gray, out, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY, 25, 15);
    gray.delete();
    let rgba = new cv.Mat();
    cv.cvtColor(out, rgba, cv.COLOR_GRAY2RGBA);
    out.delete();
    return rgba;
  }

  function getRotatedDisplayMat(srcMat){
    if (!srcMat) return null;

    let show;
    if (currentEnhanceMode === "enhanced") show = enhanceColor(srcMat);
    else if (currentEnhanceMode === "bw") show = enhanceBW(srcMat);
    else show = srcMat.clone();

    if (rotationDeg === 90) {
      const rotated = new cv.Mat();
      cv.rotate(show, rotated, cv.ROTATE_90_CLOCKWISE);
      show.delete();
      return rotated;
    }
    if (rotationDeg === 180) {
      const rotated = new cv.Mat();
      cv.rotate(show, rotated, cv.ROTATE_180);
      show.delete();
      return rotated;
    }
    if (rotationDeg === 270) {
      const rotated = new cv.Mat();
      cv.rotate(show, rotated, cv.ROTATE_90_COUNTERCLOCKWISE);
      show.delete();
      return rotated;
    }

    return show;
  }

  function renderResult(){
    if (!correctedMat) return;
    const show = getRotatedDisplayMat(correctedMat);
    if (!show) return;

    resultCanvas.width = show.cols;
    resultCanvas.height = show.rows;
    cv.imshow(resultCanvas, show);
    show.delete();
  }

  function showView(v){
    [viewStart, viewCamera, viewResult].forEach(s => s.classList.add("hidden"));
    v.classList.remove("hidden");
  }

  $("btnStart").addEventListener("click", async () => {
    const sup = supported();
    if (!sup.hasMedia){
      startError.textContent = "Camera access isn't available in this browser.";
      startError.classList.add("show");
      return;
    }
    if (!sup.secure){
      startError.textContent = "Camera access needs HTTPS (or localhost). Host this file over https:// and try again.";
      startError.classList.add("show");
      return;
    }
    try{
      showView(viewCamera);
      await startCamera();
    } catch(err){
      showView(viewStart);
      startError.textContent = describeError(err);
      startError.classList.add("show");
    }
  });

  $("btnShutter").addEventListener("click", () => {
    if (capturing) return;
    const liveWidth = video.videoWidth || 0;
    const liveHeight = video.videoHeight || 0;
    if (!liveWidth || !liveHeight) return;
    statEdges.textContent = "detecting";
    badgeText.textContent = "detecting";
    badge.classList.add("found");
    capturePhoto();
  });

  $("btnSwitch").addEventListener("click", async () => {
    if (devices.length < 2) return;
    deviceIndex = (deviceIndex + 1) % devices.length;
    deviceSelect.value = String(deviceIndex);
    try {
      await startCamera({ video: { deviceId: { exact: devices[deviceIndex].deviceId }, width:{ideal:1920}, height:{ideal:1080} }, audio:false });
    } catch(err){
      camError.textContent = describeError(err);
      camError.classList.add("show");
    }
  });

  deviceSelect.addEventListener("change", async (e) => {
    deviceIndex = Number(e.target.value);
    try {
      await startCamera({ video: { deviceId: { exact: devices[deviceIndex].deviceId }, width:{ideal:1920}, height:{ideal:1080} }, audio:false });
    } catch(err){
      camError.textContent = describeError(err);
      camError.classList.add("show");
    }
  });

  $("btnRotate").addEventListener("click", () => {
    if (!correctedMat) return;
    rotationDeg = (rotationDeg + 90) % 360;
    renderResult();
  });

  $("btnRetake").addEventListener("click", async () => {
    rotationDeg = 0;
    showView(viewCamera);
    try { await startCamera(); }
    catch(err){ camError.textContent = describeError(err); camError.classList.add("show"); }
  });

  $("btnCopy").addEventListener("click", async () => {
    if (!correctedMat) return;

    const canvas = document.createElement("canvas");
    const temp = getRotatedDisplayMat(correctedMat);
    if (!temp) return;
    canvas.width = temp.cols;
    canvas.height = temp.rows;
    cv.imshow(canvas, temp);
    temp.delete();

    try {
      const blob = await new Promise((resolve, reject) => {
        canvas.toBlob((b) => b ? resolve(b) : reject(new Error("Could not create image blob.")), "image/png", 0.96);
      });

      if (!window.isSecureContext) {
        throw new Error("Clipboard copy requires a secure context (HTTPS or localhost).");
      }

      if (navigator.clipboard && navigator.clipboard.write && typeof ClipboardItem !== "undefined") {
        await navigator.clipboard.write([
          new ClipboardItem({ [blob.type || "image/png"]: blob })
        ]);
        $("headHint").textContent = "copied";
        setTimeout(() => { $("headHint").textContent = "manual"; }, 1200);
        return;
      }

      if (navigator.clipboard && navigator.clipboard.writeText) {
        const dataUrl = canvas.toDataURL("image/png");
        await navigator.clipboard.writeText(dataUrl);
        $("headHint").textContent = "copied as data URL";
        setTimeout(() => { $("headHint").textContent = "manual"; }, 1500);
        return;
      }

      throw new Error("Clipboard API is not available in this browser.");
    } catch (err) {
      const msg = err && err.message ? err.message : "Clipboard copy is unavailable.";
      $("headHint").textContent = "copy failed";
      console.error(msg);
      setTimeout(() => { $("headHint").textContent = "manual"; }, 1800);
    }
  });

  $("enhanceRow").addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-mode]");
    if (!btn) return;
    document.querySelectorAll("#enhanceRow button").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    currentEnhanceMode = btn.dataset.mode;
    renderResult();
  });

  $("btnDownload").addEventListener("click", () => {
    const canvas = document.createElement("canvas");
    const temp = getRotatedDisplayMat(correctedMat);
    if (!temp) return;
    canvas.width = temp.cols;
    canvas.height = temp.rows;
    cv.imshow(canvas, temp);
    temp.delete();

    canvas.toBlob((blob) => {
      const ts = new Date().toISOString().replace(/[:.]/g,"-");
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `scan-${ts}.jpg`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    }, "image/jpeg", 0.92);
  });

  function describeError(err){
    const name = err && err.name;
    if (name === "NotAllowedError") return "Camera permission was denied. Allow camera access in your browser settings and retry.";
    if (name === "NotFoundError") return "No camera was found on this device.";
    if (name === "NotReadableError") return "The camera is already in use by another app.";
    return "Couldn't start the camera (" + (err && (err.message || name) || "unknown error") + ").";
  }

  waitForCv(() => {
    $("headHint").textContent = "manual";
  });

  const cvWatcher = setInterval(() => {
    if (cvReady && !viewCamera.classList.contains("hidden") && !detectLoopId && videoTrack){
      startDetectLoop();
      clearInterval(cvWatcher);
    }
    if (cvReady && viewCamera.classList.contains("hidden")) clearInterval(cvWatcher);
  }, 300);
})();

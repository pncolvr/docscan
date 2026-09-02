import { supported, createCamera } from "./camera.js";
import { detectFrame, findDocumentQuad, orderQuad } from "./detection.js";
import { warpToQuad, createImageEditor } from "./image-manipulation.js";

(() => {
  const $ = id => document.getElementById(id);
  const viewStart = $("view-start"), viewCamera = $("view-camera"), viewResult = $("view-result");
  const video = $("video"), sampleCanvas = $("sampleCanvas"), overlaySvg = $("overlaySvg");
  const badge = $("badge"), badgeText = $("badgeText"), statEdges = $("statEdges"), statRes = $("statRes");
  const deviceSelect = $("deviceSelect"), camError = $("camError"), startError = $("startError");
  let cvReady = false, capturing = false, autoCapture = true, autoStartedAt = 0;
  const autoHoldMs = 900, autoRing = $("autoring"), autoRingFg = $("autoringFg"), autoButton = $("btnAuto");
  let autoTooltipTimer = null;

  const imageEditor = createImageEditor({ resultCanvas: $("resultCanvas") });

  function setBadge(found){
    badge.classList.toggle("found", found);
    badgeText.textContent = found ? "document found" : "manual";
  }

  function drawOverlay(quad, width, height){
    overlaySvg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    if (!quad){ overlaySvg.innerHTML = ""; return; }
    const points = [quad.tl, quad.tr, quad.br, quad.bl].map(point => `${point.x},${point.y}`).join(" ");
    const circles = [quad.tl, quad.tr, quad.br, quad.bl].map(point => `<circle cx="${point.x}" cy="${point.y}" r="${width * 0.012}" fill="var(--accent)"/>`).join("");
    overlaySvg.innerHTML = `<polygon points="${points}" fill="rgba(232,163,61,0.14)" stroke="var(--accent)" stroke-width="${Math.max(width * 0.006, 2)}" stroke-linejoin="round"/>${circles}`;
  }

  function resetAutoProgress(){
    autoStartedAt = 0;
    autoRing.classList.remove("active");
    autoRingFg.style.strokeDashoffset = "97.4";
  }

  function updateAutoButton(){
    const message = autoCapture ? "Auto-capture is on. Click to disable." : "Auto-capture is off. Click to enable.";
    autoButton.classList.toggle("active", autoCapture);
    autoButton.setAttribute("aria-pressed", String(autoCapture));
    autoButton.title = message;
    autoButton.setAttribute("aria-label", message);
    autoButton.dataset.tooltip = message;
  }

  function showAutoTooltip(){
    if (autoTooltipTimer) clearTimeout(autoTooltipTimer);
    autoButton.classList.add("tooltip-visible");
    autoTooltipTimer = setTimeout(() => autoButton.classList.remove("tooltip-visible"), 10000);
  }

  updateAutoButton();

  function showView(view){
    [viewStart, viewCamera, viewResult].forEach(section => section.classList.add("hidden"));
    view.classList.remove("hidden");
  }

  function describeError(error){
    const name = error && error.name;
    if (name === "NotAllowedError") return "Camera permission was denied. Allow camera access in your browser settings and retry.";
    if (name === "NotFoundError") return "No camera was found on this device.";
    if (name === "NotReadableError") return "The camera is already in use by another app.";
    return "Couldn't start the camera (" + (error && (error.message || name) || "unknown error") + ").";
  }

  const camera = createCamera({
    video,
    deviceSelect,
    isPaused: () => capturing,
    onStatus: ({ resolution }) => {
      statRes.textContent = resolution;
      statEdges.textContent = "manual";
      setBadge(false);
      drawOverlay(null, video.videoWidth || 0, video.videoHeight || 0);
    },
    onFrame: frame => {
      if (!frame){ setBadge(false); return; }
      detectFrame({
        video: frame.video,
        sampleCanvas,
        onDetected: (quad, width, height) => {
          frame.setQuad(quad);
          statEdges.textContent = quad ? "ready" : "manual";
          setBadge(!!quad);
          drawOverlay(quad, width, height);
          if (!autoCapture || capturing || !quad){ resetAutoProgress(); return; }
          if (!autoStartedAt){ autoStartedAt = performance.now(); autoRing.classList.add("active"); }
          const progress = Math.min(1, (performance.now() - autoStartedAt) / autoHoldMs);
          autoRingFg.style.strokeDashoffset = String(97.4 * (1 - progress));
          if (progress >= 1) capture();
        }
      });
    }
  });

  async function startCamera(){
    const status = supported();
    if (!status.hasMedia) throw new Error("Camera access isn't available in this browser.");
    if (!status.secure) throw new Error("Camera access needs HTTPS (or localhost). Host this file over https:// and try again.");
    showView(viewCamera);
    showAutoTooltip();
    await camera.start();
  }

  $("btnStart").addEventListener("click", async () => {
    try {
      startError.classList.remove("show");
      await startCamera();
    } catch(error){
      showView(viewStart);
      startError.textContent = error.message.includes("Camera access") ? error.message : describeError(error);
      startError.classList.add("show");
    }
  });

  async function capture(){
    if (capturing || !video.videoWidth || !video.videoHeight) return;
    capturing = true;
    resetAutoProgress();
    $("btnShutter").disabled = true;
    statEdges.textContent = "detecting";
    badgeText.textContent = "detecting";
    badge.classList.add("found");

    const fullCanvas = document.createElement("canvas");
    fullCanvas.width = video.videoWidth;
    fullCanvas.height = video.videoHeight;
    fullCanvas.getContext("2d").drawImage(video, 0, 0, fullCanvas.width, fullCanvas.height);
    const source = cv.imread(fullCanvas);
    const liveQuad = camera.getLastQuad();
    const detected = liveQuad || findDocumentQuad(source);
    const quad = liveQuad || (detected ? orderQuad(detected) : null);
    const output = quad ? warpToQuad(source, quad) : source.clone();
    source.delete();
    await camera.stop();
    imageEditor.setMat(output);
    showView(viewResult);
    capturing = false;
    $("btnShutter").disabled = false;
  }

  $("btnShutter").addEventListener("click", capture);
  autoButton.addEventListener("click", () => {
    autoCapture = !autoCapture;
    updateAutoButton();
    resetAutoProgress();
  });

  $("btnSwitch").addEventListener("click", async () => {
    try { await camera.switchDevice(); }
    catch(error){ camError.textContent = describeError(error); camError.classList.add("show"); }
  });

  deviceSelect.addEventListener("change", async event => {
    try { await camera.selectDevice(event.target.value); }
    catch(error){ camError.textContent = describeError(error); camError.classList.add("show"); }
  });

  $("btnRotate").addEventListener("click", () => imageEditor.rotate());
  $("btnRetake").addEventListener("click", async () => {
    showView(viewCamera);
    try { await camera.start(); }
    catch(error){ camError.textContent = describeError(error); camError.classList.add("show"); }
  });

  $("btnCopy").addEventListener("click", async () => {
    try {
      await imageEditor.copy();
      $("headHint").textContent = "copied";
      setTimeout(() => { $("headHint").textContent = "manual"; }, 1200);
    } catch(error){
      $("headHint").textContent = "copy failed";
      console.error(error.message);
      setTimeout(() => { $("headHint").textContent = "manual"; }, 1800);
    }
  });

  $("enhanceRow").addEventListener("click", event => {
    const button = event.target.closest("button[data-mode]");
    if (!button) return;
    document.querySelectorAll("#enhanceRow button").forEach(item => item.classList.remove("active"));
    button.classList.add("active");
    imageEditor.setMode(button.dataset.mode);
  });

  $("btnDownload").addEventListener("click", () => imageEditor.download($("formatSelect").value));

  const cvWatcher = setInterval(() => {
    if (!window.cv?.Mat) return;
    cvReady = true;
    $("headHint").textContent = "manual";
    camera.startDetectLoop();
    clearInterval(cvWatcher);
  }, 150);
})();

import { supported, createCamera } from "./camera.js";
import { detectFrame, findDocumentQuad, orderQuad } from "./detection.js";
import { warpToQuad, createImageEditor } from "./image-manipulation.js";
import { initTranslations } from "../i18n/i18n.js";

 (async () => {
  const $ = id => document.getElementById(id);
  const { t } = await initTranslations({ selector: $("languageSelect") });
  const viewStart = $("view-start"), viewCamera = $("view-camera"), viewResult = $("view-result");
  const video = $("video"), sampleCanvas = $("sampleCanvas"), overlaySvg = $("overlaySvg");
  const controls = document.querySelector(".controls");
  const badge = $("badge"), badgeText = $("badgeText");
  const camError = $("camError"), startError = $("startError");
  const switchButton = $("btnSwitch");
  const shareButton = $("btnShare");
  const installButton = $("btnInstall");
  let deferredInstallPrompt = null;
  let cvReady = false, capturing = false, autoCapture = true, autoStartedAt = 0;
  const autoHoldMs = 900, autoRing = $("autoring"), autoRingFg = $("autoringFg"), autoButton = $("btnAuto");
  let autoTooltipTimer = null;

  const imageEditor = createImageEditor({ resultCanvas: $("resultCanvas") });

  function updateInstallButton(visible){ installButton.classList.toggle("hidden", !visible); }

  window.addEventListener("beforeinstallprompt", event => {
    event.preventDefault();
    deferredInstallPrompt = event;
    updateInstallButton(true);
  });
  window.addEventListener("appinstalled", () => {
    deferredInstallPrompt = null;
    updateInstallButton(false);
  });
  installButton.addEventListener("click", async () => {
    if (!deferredInstallPrompt) return;
    deferredInstallPrompt.prompt();
    const choice = await deferredInstallPrompt.userChoice;
    deferredInstallPrompt = null;
    updateInstallButton(false);
  });
  if (window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone) updateInstallButton(false);
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js");

  function setBadge(found){
    badge.classList.toggle("found", found);
    badgeText.textContent = found ? t("status.documentFound") : t("status.searching");
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
    const message = autoCapture ? t("camera.autoOn") : t("camera.autoOff");
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
  $("languageSelect").addEventListener("languagechange", updateAutoButton);

  function showView(view){
    [viewStart, viewCamera, viewResult].forEach(section => section.classList.add("hidden"));
    view.classList.remove("hidden");
  }

  function describeError(error){
    const name = error && error.name;
    if (name === "NotAllowedError") return t("camera.permissionDenied");
    if (name === "NotFoundError") return t("camera.notFound");
    if (name === "NotReadableError") return t("camera.notReadable");
    return t("camera.startFailed", { message: error && (error.message || name) || "unknown error" });
  }

  const camera = createCamera({
    video,
    isPaused: () => capturing,
    onStatus: ({ deviceCount = 0 } = {}) => {
      const hasMultipleCameras = deviceCount > 1;
      switchButton.classList.toggle("hidden", !hasMultipleCameras);
      controls.classList.toggle("single-camera", !hasMultipleCameras);
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
          setBadge(!!quad);
          drawOverlay(quad, width, height);
          if (!autoCapture || capturing || !quad || !camera.isAutofocusReady()){ resetAutoProgress(); return; }
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
    if (!status.hasMedia) throw new Error(t("camera.unavailable"));
    if (!status.secure) throw new Error(t("camera.insecure"));
    switchButton.classList.add("hidden");
    controls.classList.add("single-camera");
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
      startError.textContent = error.name === "NotFoundError" || error.name === "NotAllowedError" || error.name === "NotReadableError" ? describeError(error) : error.message;
      startError.classList.add("show");
    }
  });

  async function capture(){
    if (capturing || !video.videoWidth || !video.videoHeight) return;
    capturing = true;
    resetAutoProgress();
    $("btnShutter").disabled = true;
    badgeText.textContent = t("status.detecting");
    badge.classList.add("found");

    const liveQuad = camera.getLastQuad();
    let quad = liveQuad;
    if (!quad){
      const detectionCanvas = document.createElement("canvas");
      detectionCanvas.width = video.videoWidth;
      detectionCanvas.height = video.videoHeight;
      detectionCanvas.getContext("2d").drawImage(video, 0, 0, detectionCanvas.width, detectionCanvas.height);
      try {
        const detectionSource = cv.imread(detectionCanvas);
        const detected = findDocumentQuad(detectionSource);
        quad = detected ? orderQuad(detected) : null;
        detectionSource.delete();
      } catch(error){
        quad = null;
      }
    }
    await camera.focusOnQuad(quad, video.videoWidth, video.videoHeight);

    const fullCanvas = document.createElement("canvas");
    fullCanvas.width = video.videoWidth;
    fullCanvas.height = video.videoHeight;
    fullCanvas.getContext("2d").drawImage(video, 0, 0, fullCanvas.width, fullCanvas.height);
    const source = cv.imread(fullCanvas);
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

  switchButton.addEventListener("click", async () => {
    try { await camera.switchDevice(); }
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
    } catch(error){
      console.error(error.message);
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
  function supportsNativeFileShare(){
    if (typeof navigator.share !== "function" || typeof navigator.canShare !== "function") return false;
    try {
      const probe = new File([""], "scan.png", { type:"image/png" });
      return navigator.canShare({ files:[probe] });
    } catch(error){
      return false;
    }
  }

  shareButton.hidden = !supportsNativeFileShare();
  shareButton.addEventListener("click", async () => {
    try {
      await imageEditor.share($("formatSelect").value);
    } catch(error){
      if (error.name === "AbortError") return;
      console.error(error.message);
    }
  });

  const cvWatcher = setInterval(() => {
    if (!window.cv?.Mat) return;
    cvReady = true;
    camera.startDetectLoop();
    clearInterval(cvWatcher);
  }, 150);
})();

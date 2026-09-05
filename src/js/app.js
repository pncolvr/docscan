import { supported, createCamera } from "./camera.js";
import { detectFrame, findDocumentQuad, orderQuad } from "./detection.js";
import { warpToQuad, createImageEditor } from "./image-manipulation.js";
import { initializeTooltips } from "./tooltips.js";
import { initTranslations } from "../i18n/i18n.js";

 (async () => {
  const $ = id => document.getElementById(id);
  const { t } = await initTranslations({ selector: $("languageSelect") });
  const tooltips = initializeTooltips();
  const viewStart = $("view-start"), viewCamera = $("view-camera"), viewResult = $("view-result");
  const video = $("video"), sampleCanvas = $("sampleCanvas"), overlaySvg = $("overlaySvg");
  const controls = document.querySelector(".controls");
  const badge = $("badge"), badgeText = $("badgeText");
  const camError = $("camError"), startError = $("startError");
  const switchButton = $("btnSwitch");
  const installButton = $("btnInstall");
  let deferredInstallPrompt = null;
  const AUTO_CAPTURE_KEY = "scan-auto-capture";
  const AUTO_TOOLTIP_KEY = "scan-auto-tooltip-shown";
  let cvReady = false, capturing = false, autoCapture = true, autoStartedAt = 0;
  const autoHoldMs = 900, autoRing = $("autoring"), autoRingFg = $("autoringFg"), autoButton = $("btnAuto");
  const zoomView = $("zoomView"), zoomCanvas = $("zoomCanvas"), zoomLevel = $("zoomLevel");
  let zoomScale = 1;
  let panX = 0, panY = 0;
  let documents = [], selectedDocumentIndex = 0;
  let deletePending = false;
  const activeZoomPointers = new Map();
  let pinchStartDistance = 0;
  let pinchStartScale = 1;

  const imageEditor = createImageEditor({ resultCanvas: $("resultCanvas") });

  try {
    const savedAutoCapture = localStorage.getItem(AUTO_CAPTURE_KEY);
    if (savedAutoCapture !== null) autoCapture = savedAutoCapture === "true";
  } catch(error){ }

  function renderZoomImage(){
    imageEditor.renderToCanvas(zoomCanvas);
    zoomCanvas.style.transform = `translate(${panX}px, ${panY}px) scale(${zoomScale})`;
    zoomLevel.textContent = `${Math.round(zoomScale * 100)}%`;
    updateZoomButtons();
  }

  function setZoom(value){
    zoomScale = Math.max(0.5, Math.min(4, value));
    zoomCanvas.style.transform = `translate(${panX}px, ${panY}px) scale(${zoomScale})`;
    zoomLevel.textContent = `${Math.round(zoomScale * 100)}%`;
    updateZoomButtons();
  }

  function updateZoomButtons(){
    $("btnZoomOut").disabled = zoomScale <= 0.5;
    $("btnZoomIn").disabled = zoomScale >= 4;
  }

  function getPinchDistance(){
    const pointers = [...activeZoomPointers.values()];
    if (pointers.length < 2) return 0;
    return Math.hypot(pointers[1].x - pointers[0].x, pointers[1].y - pointers[0].y);
  }

  function closeZoom(){
    zoomView.classList.add("hidden");
    zoomView.setAttribute("aria-hidden", "true");
  }

  function openZoom(){
    zoomScale = 1;
    panX = 0; panY = 0;
    renderZoomImage();
    zoomView.classList.remove("hidden");
    zoomView.setAttribute("aria-hidden", "false");
    $("btnZoomClose").focus();
  }

  function syncDocumentModes(){
    const active = documents[selectedDocumentIndex];
    document.querySelectorAll("#enhanceRow button, #zoomEnhanceRow button").forEach(button => button.classList.toggle("active", button.dataset.mode === active?.mode));
  }

  function updateDocumentControls(){
    const select = $("documentSelect");
    select.innerHTML = documents.map((documentState, index) => `<option value="${index}">${t("documents.item", { number:index + 1 })}</option>`).join("");
    select.value = String(selectedDocumentIndex);
    const disabled = documents.length < 2;
    $("btnMoveUp").disabled = disabled || selectedDocumentIndex === 0;
    $("btnMoveDown").disabled = disabled || selectedDocumentIndex === documents.length - 1;
    $("btnDeleteDocument").disabled = documents.length < 1;
    $("singleExport").classList.toggle("hidden", documents.length !== 1);
    $("btnExportPdf").classList.toggle("hidden", documents.length < 2);
    $("btnSharePdf").classList.toggle("hidden", documents.length < 2 || !supportsNativeFileShare());
    syncDocumentModes();
  }

  function selectDocument(index){
    if (!documents[index]) return;
    selectedDocumentIndex = Number(index);
    imageEditor.setDocument(documents[selectedDocumentIndex]);
    updateDocumentControls();
    if (!zoomView.classList.contains("hidden")) renderZoomImage();
  }

  async function addDocument(){
    closeZoom();
    try { await startCamera(); }
    catch(error){ camError.textContent = describeError(error); camError.classList.add("show"); }
  }

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
    autoButton.setAttribute("aria-label", message);
    autoButton.dataset.tooltip = message;
    tooltips.setState(autoButton, message, "hover");
    try { localStorage.setItem(AUTO_CAPTURE_KEY, String(autoCapture)); } catch(error){ }
  }

  function showAutoTooltip(){
    try {
      if (localStorage.getItem(AUTO_TOOLTIP_KEY) === "true") return;
      localStorage.setItem(AUTO_TOOLTIP_KEY, "true");
    } catch(error){ }
    tooltips.showOnceFor(autoButton, 10000);
  }

  updateAutoButton();
  $("languageSelect").addEventListener("languagechange", () => {
    updateAutoButton();
    tooltips.refresh();
  });

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
    const documentState = { mat:output, mode:"enhanced", rotation:0 };
    documents.push(documentState);
    selectedDocumentIndex = documents.length - 1;
    imageEditor.setDocument(documentState);
    updateDocumentControls();
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

  function rotateImage(direction){
    imageEditor.rotate(direction);
    if (!zoomView.classList.contains("hidden")) renderZoomImage();
  }
  $("btnRotateClockwise").addEventListener("click", () => rotateImage(1));
  $("btnRotateCounterClockwise").addEventListener("click", () => rotateImage(-1));
  $("btnZoom").addEventListener("click", openZoom);
  $("btnZoomClose").addEventListener("click", closeZoom);
  $("btnZoomRotateClockwise").addEventListener("click", () => rotateImage(1));
  $("btnZoomRotateCounterClockwise").addEventListener("click", () => rotateImage(-1));
  $("btnZoomIn").addEventListener("click", () => setZoom(zoomScale + 0.25));
  $("btnZoomOut").addEventListener("click", () => setZoom(zoomScale - 0.25));
  const zoomStage = $("zoomStage");
  zoomStage.addEventListener("pointerdown", event => {
    activeZoomPointers.set(event.pointerId, { x:event.clientX, y:event.clientY });
    zoomStage.setPointerCapture(event.pointerId);
    if (activeZoomPointers.size === 2){
      pinchStartDistance = getPinchDistance();
      pinchStartScale = zoomScale;
    }
  });
  zoomStage.addEventListener("pointermove", event => {
    if (!activeZoomPointers.has(event.pointerId)) return;
    event.preventDefault();
    const previous = activeZoomPointers.get(event.pointerId);
    activeZoomPointers.set(event.pointerId, { x:event.clientX, y:event.clientY });
    if (activeZoomPointers.size === 1){
      panX += event.clientX - previous.x;
      panY += event.clientY - previous.y;
      zoomCanvas.style.transform = `translate(${panX}px, ${panY}px) scale(${zoomScale})`;
      return;
    }
    if (activeZoomPointers.size === 2 && pinchStartDistance){
      setZoom(pinchStartScale * getPinchDistance() / pinchStartDistance);
    }
  });
  zoomStage.addEventListener("wheel", event => {
    event.preventDefault();
    setZoom(zoomScale + (event.deltaY < 0 ? 0.1 : -0.1));
  }, { passive:false });
  function endZoomPointer(event){
    activeZoomPointers.delete(event.pointerId);
    if (activeZoomPointers.size < 2) pinchStartDistance = 0;
  }
  zoomStage.addEventListener("pointerup", endZoomPointer);
  zoomStage.addEventListener("pointercancel", endZoomPointer);
  document.addEventListener("keydown", event => {
    if (event.key === "Escape" && !zoomView.classList.contains("hidden")) closeZoom();
  });
  $("documentSelect").addEventListener("change", event => selectDocument(event.target.value));
  $("btnAddDocument").addEventListener("click", addDocument);
  $("btnMoveUp").addEventListener("click", () => {
    if (selectedDocumentIndex < 1) return;
    [documents[selectedDocumentIndex - 1], documents[selectedDocumentIndex]] = [documents[selectedDocumentIndex], documents[selectedDocumentIndex - 1]];
    selectedDocumentIndex -= 1;
    updateDocumentControls();
    $("documentSelect").value = String(selectedDocumentIndex);
  });
  $("btnMoveDown").addEventListener("click", () => {
    if (selectedDocumentIndex >= documents.length - 1) return;
    [documents[selectedDocumentIndex + 1], documents[selectedDocumentIndex]] = [documents[selectedDocumentIndex], documents[selectedDocumentIndex + 1]];
    selectedDocumentIndex += 1;
    updateDocumentControls();
    $("documentSelect").value = String(selectedDocumentIndex);
  });
  const deleteButton = $("btnDeleteDocument");
  function cancelDelete(){
    if (!deletePending) return;
    deletePending = false;
    deleteButton.classList.remove("delete-confirm");
    deleteButton.dataset.tooltip = t("documents.deleteTooltip");
    tooltips.setState(deleteButton, t("documents.deleteTooltip"), "hover");
    tooltips.hide();
  }
  document.addEventListener("pointerdown", event => {
    if (deletePending && !event.target.closest("#btnDeleteDocument")) cancelDelete();
  });
  deleteButton.addEventListener("click", () => {
    if (!deletePending){
      deletePending = true;
      deleteButton.classList.add("delete-confirm");
      deleteButton.dataset.tooltip = t("documents.deleteConfirm");
      tooltips.showPersistent(deleteButton, t("documents.deleteConfirm"));
      return;
    }
    deletePending = false;
    deleteButton.classList.remove("delete-confirm");
    tooltips.hide();
    const removed = documents.splice(selectedDocumentIndex, 1)[0];
    removed?.mat.delete();
    if (!documents.length){
      showView(viewStart);
      return;
    }
    selectedDocumentIndex = Math.min(selectedDocumentIndex, documents.length - 1);
    imageEditor.setDocument(documents[selectedDocumentIndex]);
    updateDocumentControls();
  });

  [$("enhanceRow"), $("zoomEnhanceRow")].forEach(row => row.addEventListener("click", event => {
    const button = event.target.closest("button[data-mode]");
    if (!button) return;
    imageEditor.setMode(button.dataset.mode);
    syncDocumentModes();
    if (!zoomView.classList.contains("hidden")) renderZoomImage();
  }));

  $("btnCopy").addEventListener("click", async () => {
    try { await imageEditor.copy(); }
    catch(error){ console.error(error.message); }
  });
  $("btnDownload").addEventListener("click", () => imageEditor.download($("formatSelect").value));
  function supportsNativeFileShare(){
    if (typeof navigator.share !== "function" || typeof navigator.canShare !== "function") return false;
    try { return navigator.canShare({ files:[new File([""], "scan.png", { type:"image/png" })] }); }
    catch(error){ return false; }
  }
  $("btnShare").classList.toggle("hidden", !supportsNativeFileShare());
  $("btnShare").addEventListener("click", async () => {
    try { await imageEditor.share($("formatSelect").value); }
    catch(error){ if (error.name !== "AbortError") console.error(error.message); }
  });
  $("btnSharePdf").addEventListener("click", async () => {
    try { await imageEditor.sharePdf(documents); }
    catch(error){ if (error.name !== "AbortError") console.error(error.message); }
  });
  $("btnExportPdf").addEventListener("click", () => imageEditor.downloadPdf(documents));
  $("languageSelect").addEventListener("languagechange", updateDocumentControls);

  const cvWatcher = setInterval(() => {
    if (!window.cv?.Mat) return;
    cvReady = true;
    camera.startDetectLoop();
    clearInterval(cvWatcher);
  }, 150);
})();

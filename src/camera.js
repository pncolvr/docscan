export function supported(){
  const secure = location.protocol === "https:" || location.hostname === "localhost" || location.hostname === "127.0.0.1";
  return { secure, hasMedia: !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia) };
}

export function createCamera({ video, deviceSelect, onStatus, onFrame, isPaused }){
  let stream = null;
  let videoTrack = null;
  let devices = [];
  let deviceIndex = -1;
  let detectLoopId = null;
  let lastQuad = null;
  let autofocusReady = false;

  function startDetectLoop(){
    stopDetectLoop();
    if (!window.cv || !window.cv.Mat) return;
    detectLoopId = setInterval(() => {
      if (!video.videoWidth || isPaused()) return;
      onFrame({ video, lastQuad, setQuad: quad => { lastQuad = quad; } });
    }, 220);
  }

  function stopDetectLoop(){
    if (detectLoopId){ clearInterval(detectLoopId); detectLoopId = null; }
    lastQuad = null;
    onFrame(null);
  }

  async function start(constraintsOverride){
    await stop();
    autofocusReady = false;
    const base = constraintsOverride || { video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false };
    stream = await navigator.mediaDevices.getUserMedia(base);
    video.srcObject = stream;
    await video.play();
    videoTrack = stream.getVideoTracks()[0];
    try { await videoTrack.applyConstraints({ advanced:[{ focusMode:"continuous" }] }); } catch(error) { }
    await new Promise(resolve => setTimeout(resolve, 1000));
    autofocusReady = true;
    const all = await navigator.mediaDevices.enumerateDevices();
    devices = all.filter(device => device.kind === "videoinput");
    if (devices.length > 1){
      deviceSelect.classList.remove("hidden");
      deviceSelect.innerHTML = devices.map((device, index) => `<option value="${index}">${device.label || "Camera " + (index + 1)}</option>`).join("");
      const current = devices.findIndex(device => device.deviceId === videoTrack.getSettings().deviceId);
      deviceIndex = current >= 0 ? current : 0;
      deviceSelect.value = String(deviceIndex);
    } else deviceSelect.classList.add("hidden");
    onStatus({ resolution: `${videoTrack.getSettings().width || video.videoWidth}×${videoTrack.getSettings().height || video.videoHeight}` });
    startDetectLoop();
  }

  async function stop(){
    autofocusReady = false;
    stopDetectLoop();
    if (stream){ stream.getTracks().forEach(track => track.stop()); stream = null; }
    videoTrack = null;
  }

  async function switchDevice(){
    if (devices.length < 2) return;
    deviceIndex = (deviceIndex + 1) % devices.length;
    deviceSelect.value = String(deviceIndex);
    await start({ video: { deviceId: { exact: devices[deviceIndex].deviceId }, width:{ideal:1920}, height:{ideal:1080} }, audio:false });
  }

  async function selectDevice(index){
    deviceIndex = Number(index);
    await start({ video: { deviceId: { exact: devices[deviceIndex].deviceId }, width:{ideal:1920}, height:{ideal:1080} }, audio:false });
  }

  async function focusOnQuad(quad, width, height){
    if (!videoTrack || !quad || !width || !height) return;
    const pointsOfInterest = [{
      x: Math.max(0, Math.min(1, (quad.tl.x + quad.tr.x + quad.br.x + quad.bl.x) / 4 / width)),
      y: Math.max(0, Math.min(1, (quad.tl.y + quad.tr.y + quad.br.y + quad.bl.y) / 4 / height))
    }];
    try {
      await videoTrack.applyConstraints({ advanced:[{ focusMode:"single-shot", pointsOfInterest }] });
    } catch(error){
      try { await videoTrack.applyConstraints({ advanced:[{ pointsOfInterest }] }); }
      catch(focusError){ return; }
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }

  return { start, stop, startDetectLoop, switchDevice, selectDevice, getLastQuad: () => lastQuad, isAutofocusReady: () => autofocusReady, focusOnQuad };
}
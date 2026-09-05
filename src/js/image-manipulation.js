export function warpToQuad(mat, quad){
  const { tl, tr, br, bl } = quad;
  const maxWidth = Math.max(Math.hypot(br.x - bl.x, br.y - bl.y), Math.hypot(tr.x - tl.x, tr.y - tl.y));
  const maxHeight = Math.max(Math.hypot(tr.x - br.x, tr.y - br.y), Math.hypot(tl.x - bl.x, tl.y - bl.y));
  const source = cv.matFromArray(4, 1, cv.CV_32FC2, [tl.x,tl.y, tr.x,tr.y, br.x,br.y, bl.x,bl.y]);
  const target = cv.matFromArray(4, 1, cv.CV_32FC2, [0,0, maxWidth,0, maxWidth,maxHeight, 0,maxHeight]);
  const transform = cv.getPerspectiveTransform(source, target), output = new cv.Mat();
  cv.warpPerspective(mat, output, transform, new cv.Size(maxWidth, maxHeight), cv.INTER_CUBIC, cv.BORDER_CONSTANT, new cv.Scalar());
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
  let currentDocument = null;
  function displayMat(documentState = currentDocument){
    if (!documentState?.mat) return null;
    let output = documentState.mode === "enhanced" ? enhanceColor(documentState.mat) : documentState.mode === "bw" ? enhanceBW(documentState.mat) : documentState.mat.clone();
    if (documentState.rotation){
      const rotated = new cv.Mat();
      const rotateMode = documentState.rotation === 90 ? cv.ROTATE_90_CLOCKWISE : documentState.rotation === 180 ? cv.ROTATE_180 : cv.ROTATE_90_COUNTERCLOCKWISE;
      cv.rotate(output, rotated, rotateMode); output.delete(); output = rotated;
    }
    return output;
  }
  function render(){ renderDocumentToCanvas(currentDocument, resultCanvas); }
  function renderDocumentToCanvas(documentState, canvas){
    const output = displayMat(documentState); if (!output) return false;
    canvas.width = output.cols; canvas.height = output.rows; cv.imshow(canvas, output); output.delete();
    return true;
  }
  function setMat(mat){
    if (currentDocument?.mat) currentDocument.mat.delete();
    currentDocument = { mat, mode:"enhanced", rotation:0 };
    render();
    return currentDocument;
  }
  function setDocument(documentState){ currentDocument = documentState; render(); }
  const formats = { jpeg:{ mime:"image/jpeg", extension:"jpg", quality:0.98 }, png:{ mime:"image/png", extension:"png" }, webp:{ mime:"image/webp", extension:"webp", quality:0.98 }, pdf:{ mime:"application/pdf", extension:"pdf" } };
  function canvasToJpegBytes(canvas){
    const base64 = canvas.toDataURL("image/jpeg", 0.95).split(",")[1];
    const binary = atob(base64), bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
    return bytes;
  }
  async function makePdf(documentStates){
    if (!window.PDFLib?.PDFDocument) throw new Error("PDF export is not available.");
    const canvases = documentStates.map(documentState => {
      const canvas = document.createElement("canvas");
      return renderDocumentToCanvas(documentState, canvas) ? canvas : null;
    });
    const firstCanvas = canvases.find(Boolean);
    if (!firstCanvas) throw new Error("No documents are available for PDF export.");
    const pdf = await window.PDFLib.PDFDocument.create();
    for (const canvas of canvases.filter(Boolean)){
      const page = pdf.addPage([canvas.width, canvas.height]);
      const image = await pdf.embedJpg(canvasToJpegBytes(canvas));
      page.drawImage(image, { x:0, y:0, width:canvas.width, height:canvas.height });
    }
    return pdf.save();
  }
  async function downloadPdf(documentStates){
    const bytes = await makePdf(documentStates), link = document.createElement("a");
    link.href = URL.createObjectURL(new Blob([bytes], { type:"application/pdf" }));
    link.download = `scan-${new Date().toISOString().replace(/[:.]/g,"-")}.pdf`;
    link.click(); setTimeout(() => URL.revokeObjectURL(link.href), 4000);
  }
  async function sharePdf(documentStates){
    const bytes = await makePdf(documentStates);
    const file = new File([bytes], `scan-${new Date().toISOString().replace(/[:.]/g,"-")}.pdf`, { type:"application/pdf" });
    if (!navigator.share || !navigator.canShare?.({ files:[file] })) throw new Error("Native PDF sharing is not available in this browser.");
    await navigator.share({ title:"Scanned documents", files:[file] });
  }
  function renderCanvas(){
    const canvas = document.createElement("canvas");
    return renderDocumentToCanvas(currentDocument, canvas) ? canvas : null;
  }
  async function copy(){
    const canvas = renderCanvas(); if (!canvas) return;
    const blob = await new Promise((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error("Could not create image blob.")), "image/png", 0.96));
    if (!window.isSecureContext) throw new Error("Clipboard copy requires a secure context (HTTPS or localhost).");
    if (navigator.clipboard?.write && typeof ClipboardItem !== "undefined") return navigator.clipboard.write([new ClipboardItem({ [blob.type || "image/png"]: blob })]);
    if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(canvas.toDataURL("image/png"));
    throw new Error("Clipboard API is not available in this browser.");
  }
  function download(format = "jpeg"){
    const formats = { jpeg:["image/jpeg", "jpg", 0.98], png:["image/png", "png"], webp:["image/webp", "webp", 0.98], pdf:["application/pdf", "pdf"] };
    if (format === "pdf") return downloadPdf([currentDocument]);
    const selected = formats[format] || formats.jpeg, canvas = renderCanvas(); if (!canvas) return;
    canvas.toBlob(blob => {
      if (!blob) return;
      const link = document.createElement("a"); link.href = URL.createObjectURL(blob);
      link.download = `scan-${new Date().toISOString().replace(/[:.]/g,"-")}.${selected[1]}`;
      link.click(); setTimeout(() => URL.revokeObjectURL(link.href), 4000);
    }, selected[0], selected[2]);
  }
  async function share(format = "jpeg"){
    const canvas = renderCanvas(); if (!canvas) return;
      const blob = format === "pdf" ? new Blob([await makePdf([currentDocument])], { type:"application/pdf" }) : await new Promise((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error("Could not create image blob.")), "image/png", 0.96));
      const extension = format === "pdf" ? "pdf" : "png";
      const file = new File([blob], `scan-${new Date().toISOString().replace(/[:.]/g,"-")}.${extension}`, { type:blob.type || (format === "pdf" ? "application/pdf" : "image/png") });
    if (!navigator.share || !navigator.canShare?.({ files:[file] })) throw new Error("Native image sharing is not available in this browser.");
    await navigator.share({ title:"Scanned document", files:[file] });
  }
  return {
    setMat, setDocument, renderToCanvas: canvas => renderDocumentToCanvas(currentDocument, canvas),
    renderDocumentToCanvas, downloadPdf, sharePdf, copy, download, share,
    rotate: (direction = 1) => { if (currentDocument){ currentDocument.rotation = (currentDocument.rotation + direction * 90 + 360) % 360; render(); } },
    setMode: value => { if (currentDocument){ currentDocument.mode = value; render(); } },
    getDocument: () => currentDocument
  };
}
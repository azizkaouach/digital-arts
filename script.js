const uploadPanel = document.querySelector("#uploadPanel");
const optionsRow = document.querySelector("#optionsRow");
const dropZone = document.querySelector("#dropZone");
const imageInput = document.querySelector("#imageInput");
const loadingState = document.querySelector("#loadingState");
const loadingMessage = document.querySelector("#loadingMessage");
const resultView = document.querySelector("#resultView");
const originalImage = document.querySelector("#originalImage");
const generatedImage = document.querySelector("#generatedImage");
const storyText = document.querySelector("#storyText");
const storyCard = document.querySelector("#storyCard");
const aboutText = document.querySelector("#aboutText");
const aboutCard = document.querySelector("#aboutCard");
const legendList = document.querySelector("#legendList");
const errorMessage = document.querySelector("#errorMessage");
const changeImageButton = document.querySelector("#changeImageButton");
const downloadButton = document.querySelector("#downloadButton");
const printButton = document.querySelector("#printButton");
const colorCount = document.querySelector("#colorCount");
const colorCountValue = document.querySelector("#colorCountValue");
const wantStoryToggle = document.querySelector("#wantStory");
const loadingPhoto = document.querySelector("#loadingPhoto");
const numbersImage = document.querySelector("#numbersImage");
const numbersToggle = document.querySelector("#toggleNumbers");

// Interactive Coloring UI
const interactiveCanvas = document.querySelector("#interactiveCanvas");
const intCtx = interactiveCanvas.getContext("2d", { willReadFrequently: true });
const toolBrush = document.querySelector("#toolBrush");
const toolFill = document.querySelector("#toolFill");
const toolEraser = document.querySelector("#toolEraser");
const toolClear = document.querySelector("#toolClear");
const brushSize = document.querySelector("#brushSize");
const brushSizeValue = document.querySelector("#brushSizeValue");

let currentTool = "brush";
let activeColor = "#ff7a59";
let isDrawing = false;
let lastX = 0;
let lastY = 0;

const LOADING_MESSAGES = [
  "Mixing the colors…",
  "Drawing the outlines…",
  "Numbering the regions…",
  "Sharpening the pencils…",
  "Almost ready…",
];

let originalPreviewUrl = "";
let selectedFile = null;
let loadingInterval = null;

dropZone.addEventListener("dragover", (event) => {
  event.preventDefault();
  dropZone.classList.add("is-dragging");
});

dropZone.addEventListener("dragleave", () => {
  dropZone.classList.remove("is-dragging");
});

dropZone.addEventListener("drop", (event) => {
  event.preventDefault();
  dropZone.classList.remove("is-dragging");
  const file = event.dataTransfer.files[0];
  if (file) handleFile(file);
});

imageInput.addEventListener("change", () => {
  const file = imageInput.files[0];
  if (file) handleFile(file);
});

changeImageButton.addEventListener("click", openImagePicker);
downloadButton.addEventListener("click", downloadPage);
printButton.addEventListener("click", printPage);
document.querySelector("#show3dButton").addEventListener("click", openShowcase3d);

let currentLegend = [];
let latestPreviewUrl = "";
let latestOutlineUrl = "";
let numbersVisible = true;

function applyNumbersVisibility() {
  numbersImage.style.visibility = numbersVisible ? "visible" : "hidden";
  numbersToggle.classList.toggle("active", numbersVisible);
  numbersToggle.setAttribute("aria-pressed", String(numbersVisible));
}

numbersToggle.addEventListener("click", () => {
  numbersVisible = !numbersVisible;
  applyNumbersVisibility();
});

async function openShowcase3d() {
  if (!generatedImage.src || !interactiveCanvas.width) return;
  try {
    // Answer key first, then the child's own paint on top, no numbers.
    const w = interactiveCanvas.width;
    const h = interactiveCanvas.height;
    const composite = document.createElement("canvas");
    composite.width = w;
    composite.height = h;
    const cctx = composite.getContext("2d");
    if (latestPreviewUrl) cctx.drawImage(await loadImage(latestPreviewUrl), 0, 0, w, h);
    cctx.drawImage(interactiveCanvas, 0, 0);
    const outlineImage = latestOutlineUrl ? await loadImage(latestOutlineUrl) : generatedImage;
    const { openShowcase } = await import("/viewer3d.js");
    openShowcase({ paintCanvas: composite, outlineImage, legend: currentLegend });
  } catch (error) {
    showError("The 3D card could not open. Try again in a moment.");
    console.error(error);
  }
}

colorCount.addEventListener("input", () => {
  colorCountValue.textContent = colorCount.value;
});

function openImagePicker() {
  imageInput.value = "";
  imageInput.click();
}

let saveToGallery = true;
let runToken = 0;
const MAX_UPLOAD_SIDE = 1400;

// Downscale big photos in the browser so phone uploads stay small and fast.
async function downscaleImage(file) {
  try {
    const bitmap = await createImageBitmap(file);
    const longSide = Math.max(bitmap.width, bitmap.height);
    if (longSide <= MAX_UPLOAD_SIDE) {
      bitmap.close();
      return file;
    }
    const scale = MAX_UPLOAD_SIDE / longSide;
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.9));
    if (!blob || blob.size >= file.size) return file;
    const name = (file.name || "photo").replace(/\.[^.]+$/, "") + ".jpg";
    return new File([blob], name, { type: "image/jpeg" });
  } catch {
    return file; // keep the original if the browser cannot decode it
  }
}

async function handleFile(file, { save = true, exact = false } = {}) {
  saveToGallery = save;
  clearError();

  if (!file.type.startsWith("image/")) {
    showError("Please upload an image file.");
    return;
  }

  if (originalPreviewUrl) URL.revokeObjectURL(originalPreviewUrl);

  selectedFile = file;
  originalPreviewUrl = URL.createObjectURL(file);
  originalImage.src = originalPreviewUrl;
  loadingPhoto.src = originalPreviewUrl;

  const token = ++runToken;
  clearTimeout(textPollTimer);
  setState("loading");
  const upload = exact ? file : await downscaleImage(file);
  if (token !== runToken) return;
  await runGeneration(upload, token);
}

let textPollTimer = null;

async function runGeneration(upload, token) {
  const formData = new FormData();
  formData.append("image", upload);
  formData.append("n_colors", colorCount.value);
  formData.append("want_story", "false");
  formData.append("save_to_gallery", saveToGallery ? "true" : "false");

  // Story and fun facts load in parallel; the page does not wait for them.
  renderStory("");
  renderAbout("");
  if (wantStoryToggle.checked) {
    const textForm = new FormData();
    textForm.append("image", upload);
    fetchText(textForm, token);
  }

  try {
    const response = await fetch("/api/transform", {
      method: "POST",
      body: formData,
    });

    const payload = await response.json();
    if (token !== runToken) return;
    if (!response.ok) {
      throw new Error(payload.detail || "The transformation failed.");
    }
    if (!payload.image_base64) {
      throw new Error("The server did not return a coloring page.");
    }

    await showPage(payload);
    if (token !== runToken) return;

    renderLegend(payload.legend || []);
    setState("result");
    if (saveToGallery) loadGallery();
  } catch (error) {
    if (token !== runToken) return;
    setState("upload");
    showError(error.message);
  }
}

const dataUrl = (b64) => `data:image/png;base64,${b64}`;

async function showPage(payload) {
  const hasLayers = Boolean(payload.outline_base64 && payload.numbers_base64);
  latestPreviewUrl = payload.preview_base64 ? dataUrl(payload.preview_base64) : "";
  latestOutlineUrl = payload.outline_base64 ? dataUrl(payload.outline_base64) : "";
  window.outlineData = null; // flood-fill walls are re-read for the new page

  const bottomUrl = hasLayers ? latestOutlineUrl : dataUrl(payload.image_base64);
  generatedImage.src = bottomUrl;
  numbersImage.src = hasLayers ? dataUrl(payload.numbers_base64) : "";
  numbersImage.hidden = !hasLayers;
  numbersToggle.hidden = !hasLayers;
  applyNumbersVisibility();

  await generatedImage.decode();
  if (hasLayers) await numbersImage.decode().catch(() => {});
  interactiveCanvas.width = generatedImage.naturalWidth;
  interactiveCanvas.height = generatedImage.naturalHeight;
  intCtx.lineCap = "round";
  intCtx.lineJoin = "round";
}

async function fetchText(formData, token) {
  clearTimeout(textPollTimer);

  try {
    const res = await fetch("/api/text", {
      method: "POST",
      body: formData,
    });

    if (token !== runToken) return;
    if (res.status === 429) {
      textPollTimer = setTimeout(() => fetchText(formData, token), 15000);
      return;
    }

    if (!res.ok) {
      throw new Error("Failed to fetch text");
    }

    const payload = await res.json();
    if (token !== runToken) return; // user picked another picture meanwhile
    if (payload.story) renderStory(payload.story);
    if (payload.about) renderAbout(payload.about);
  } catch (err) {
    console.error("Text error:", err);
  }
}

function renderLegend(legend) {
  currentLegend = legend;
  legendList.innerHTML = "";
  legend.forEach((entry, idx) => {
    const li = document.createElement("li");
    li.className = "legend-item";
    
    if (idx === 0) {
      li.classList.add("active");
      activeColor = entry.hex;
    }

    const swatch = document.createElement("span");
    swatch.className = "legend-swatch";
    swatch.style.backgroundColor = entry.hex;
    swatch.textContent = entry.number;

    const meta = document.createElement("span");
    meta.className = "legend-meta";
    meta.innerHTML = `<strong>${entry.number}</strong><span>${entry.hex}</span>`;

    li.append(swatch, meta);
    
    li.addEventListener("click", () => {
      document.querySelectorAll(".legend-item").forEach(item => item.classList.remove("active"));
      li.classList.add("active");
      activeColor = entry.hex;
      if (currentTool === "eraser") setTool("brush");
    });
    
    legendList.append(li);
  });
}

function renderStory(story) {
  if (!story) {
    storyCard.hidden = true;
    storyText.textContent = "";
    return;
  }
  storyText.textContent = story;
  storyCard.hidden = false;
}

function renderAbout(about) {
  if (!about) {
    aboutCard.hidden = true;
    aboutText.textContent = "";
    return;
  }
  aboutText.textContent = about;
  aboutCard.hidden = false;
}

function downloadPage() {
  if (!generatedImage.src) return;
  
  const mergeCanvas = document.createElement("canvas");
  mergeCanvas.width = generatedImage.naturalWidth;
  mergeCanvas.height = generatedImage.naturalHeight;
  const mctx = mergeCanvas.getContext("2d");
  
  mctx.fillStyle = "#ffffff";
  mctx.fillRect(0, 0, mergeCanvas.width, mergeCanvas.height);
  
  // Paint first, then outlines on top with multiply (no numbers)
  mctx.drawImage(interactiveCanvas, 0, 0);
  mctx.globalCompositeOperation = "multiply";
  mctx.drawImage(generatedImage, 0, 0);
  
  const link = document.createElement("a");
  link.href = mergeCanvas.toDataURL("image/png");
  link.download = "my-painting.png";
  document.body.append(link);
  link.click();
  link.remove();
}

function printPage() {
  if (!generatedImage.src) return;
  document.body.classList.add("is-printing");
  numbersImage.style.visibility = numbersImage.hidden ? "hidden" : "visible"; // paper needs numbers
  const cleanup = () => {
    document.body.classList.remove("is-printing");
    applyNumbersVisibility();
    window.removeEventListener("afterprint", cleanup);
  };
  window.addEventListener("afterprint", cleanup);
  window.print();
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = reject;
    image.src = src;
  });
}

function setState(state) {
  uploadPanel.hidden = state !== "upload";
  optionsRow.hidden = state !== "upload";
  galleryEl.hidden = state !== "upload";
  loadingState.hidden = state !== "loading";
  resultView.hidden = state !== "result";

  if (loadingInterval) {
    clearInterval(loadingInterval);
    loadingInterval = null;
  }
  if (state === "loading") {
    let i = 0;
    loadingMessage.textContent = LOADING_MESSAGES[0];
    loadingInterval = setInterval(() => {
      i = (i + 1) % LOADING_MESSAGES.length;
      loadingMessage.textContent = LOADING_MESSAGES[i];
    }, 2200);
  }
}

function showError(message) {
  errorMessage.textContent = message;
  errorMessage.hidden = false;
}

function clearError() {
  errorMessage.textContent = "";
  errorMessage.hidden = true;
}

// --- Interactive Drawing Logic ---

toolBrush.addEventListener("click", () => setTool("brush"));
toolFill.addEventListener("click", () => setTool("fill"));
toolEraser.addEventListener("click", () => setTool("eraser"));
toolClear.addEventListener("click", () => {
  intCtx.clearRect(0, 0, interactiveCanvas.width, interactiveCanvas.height);
});

brushSize.addEventListener("input", () => {
  brushSizeValue.textContent = brushSize.value;
});

function setTool(tool) {
  currentTool = tool;
  toolBrush.classList.toggle("active", tool === "brush");
  toolFill.classList.toggle("active", tool === "fill");
  toolEraser.classList.toggle("active", tool === "eraser");
  
  if (tool === "eraser") {
    interactiveCanvas.style.cursor = "crosshair";
  } else if (tool === "fill") {
    interactiveCanvas.style.cursor = "crosshair";
  } else {
    interactiveCanvas.style.cursor = "crosshair";
  }
}

function getPos(e) {
  const rect = interactiveCanvas.getBoundingClientRect();
  const scaleX = interactiveCanvas.width / rect.width;
  const scaleY = interactiveCanvas.height / rect.height;
  let clientX = e.clientX;
  let clientY = e.clientY;
  if (e.touches && e.touches.length > 0) {
    clientX = e.touches[0].clientX;
    clientY = e.touches[0].clientY;
  }
  return {
    x: (clientX - rect.left) * scaleX,
    y: (clientY - rect.top) * scaleY
  };
}

function startDrawing(e) {
  if (e.cancelable) e.preventDefault();
  isDrawing = true;
  const pos = getPos(e);
  lastX = pos.x;
  lastY = pos.y;
  
  if (currentTool === "fill") {
    isDrawing = false;
    floodFill(Math.floor(pos.x), Math.floor(pos.y), hexToRgb(activeColor));
  } else {
    draw(e);
  }
}

function draw(e) {
  if (!isDrawing) return;
  if (e.cancelable) e.preventDefault();
  const pos = getPos(e);
  
  intCtx.lineWidth = brushSize.value;
  
  if (currentTool === "eraser") {
    intCtx.globalCompositeOperation = "destination-out";
    intCtx.strokeStyle = "rgba(0,0,0,1)";
  } else {
    intCtx.globalCompositeOperation = "source-over";
    intCtx.strokeStyle = activeColor;
  }
  
  intCtx.beginPath();
  intCtx.moveTo(lastX, lastY);
  intCtx.lineTo(pos.x, pos.y);
  intCtx.stroke();
  
  lastX = pos.x;
  lastY = pos.y;
}

function stopDrawing() {
  isDrawing = false;
}

interactiveCanvas.addEventListener("mousedown", startDrawing);
interactiveCanvas.addEventListener("mousemove", draw);
interactiveCanvas.addEventListener("mouseup", stopDrawing);
interactiveCanvas.addEventListener("mouseleave", stopDrawing);

interactiveCanvas.addEventListener("touchstart", startDrawing, {passive: false});
interactiveCanvas.addEventListener("touchmove", draw, {passive: false});
interactiveCanvas.addEventListener("touchend", stopDrawing);
interactiveCanvas.addEventListener("touchcancel", stopDrawing);

function hexToRgb(hex) {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return result ? {
    r: parseInt(result[1], 16),
    g: parseInt(result[2], 16),
    b: parseInt(result[3], 16)
  } : {r:0,g:0,b:0};
}

function floodFill(startX, startY, fillColorRgb) {
  const canvasWidth = interactiveCanvas.width;
  const canvasHeight = interactiveCanvas.height;
  
  if (!window.outlineData) { // walls = outline-only image, so numbers never block a fill
    const tempCanvas = document.createElement("canvas");
    tempCanvas.width = canvasWidth;
    tempCanvas.height = canvasHeight;
    const tempCtx = tempCanvas.getContext("2d", { willReadFrequently: true });
    tempCtx.drawImage(generatedImage, 0, 0);
    window.outlineData = tempCtx.getImageData(0, 0, canvasWidth, canvasHeight).data;
  }
  
  const outlineData = window.outlineData;
  const imageData = intCtx.getImageData(0, 0, canvasWidth, canvasHeight);
  const data = imageData.data;
  
  const startPos = (startY * canvasWidth + startX) * 4;
  
  // Abort if clicking on black outline
  if (outlineData[startPos] < 50 && outlineData[startPos+1] < 50 && outlineData[startPos+2] < 50) return;
  
  const targetR = data[startPos];
  const targetG = data[startPos + 1];
  const targetB = data[startPos + 2];
  const targetA = data[startPos + 3];
  
  const fillR = fillColorRgb.r;
  const fillG = fillColorRgb.g;
  const fillB = fillColorRgb.b;
  
  if (targetR === fillR && targetG === fillG && targetB === fillB && targetA === 255) return;
  
  const stack = [[startX, startY]];
  
  function matchStartColor(pixelPos) {
    if (outlineData[pixelPos] < 100 && outlineData[pixelPos+1] < 100 && outlineData[pixelPos+2] < 100) return false;
    const r = data[pixelPos];
    const g = data[pixelPos + 1];
    const b = data[pixelPos + 2];
    const a = data[pixelPos + 3];
    return r === targetR && g === targetG && b === targetB && a === targetA;
  }
  
  function colorPixel(pixelPos) {
    data[pixelPos] = fillR;
    data[pixelPos + 1] = fillG;
    data[pixelPos + 2] = fillB;
    data[pixelPos + 3] = 255;
  }
  
  while(stack.length) {
    const [x, y] = stack.pop();
    let currentX = x;
    let pixelPos = (y * canvasWidth + currentX) * 4;
    
    while(currentX >= 0 && matchStartColor(pixelPos)) {
      currentX--;
      pixelPos -= 4;
    }
    
    currentX++;
    pixelPos += 4;
    
    let reachAbove = false;
    let reachBelow = false;
    
    while(currentX < canvasWidth && matchStartColor(pixelPos)) {
      colorPixel(pixelPos);
      
      if(y > 0) {
        if(matchStartColor(pixelPos - canvasWidth * 4)) {
          if(!reachAbove) {
            stack.push([currentX, y - 1]);
            reachAbove = true;
          }
        } else if(reachAbove) {
          reachAbove = false;
        }
      }
      
      if(y < canvasHeight - 1) {
        if(matchStartColor(pixelPos + canvasWidth * 4)) {
          if(!reachBelow) {
            stack.push([currentX, y + 1]);
            reachBelow = true;
          }
        } else if(reachBelow) {
          reachBelow = false;
        }
      }
      
      currentX++;
      pixelPos += 4;
    }
  }
  
  intCtx.putImageData(imageData, 0, 0);
}

/* ---------- Gallery ---------- */
const galleryEl = document.querySelector("#gallery");
const galleryGrid = document.querySelector("#galleryGrid");
const galleryMore = document.querySelector("#galleryMore");
const GALLERY_VISIBLE = 12;
let galleryItems = [];
let galleryExpanded = false;

async function loadGallery() {
  try {
    const response = await fetch("/api/gallery");
    if (!response.ok) throw new Error("gallery unavailable");
    galleryItems = (await response.json()).items || [];
  } catch {
    galleryItems = [];
  }
  renderGallery();
}

function renderGallery() {
  galleryGrid.replaceChildren();
  const shown = galleryExpanded ? galleryItems : galleryItems.slice(0, GALLERY_VISIBLE);

  shown.forEach((item) => {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "gallery-item";
    card.setAttribute("aria-label", `Color ${item.name}`);

    const img = document.createElement("img");
    img.src = item.url;
    img.alt = item.name;
    img.loading = "lazy";
    card.appendChild(img);

    if (item.kind === "upload") {
      const badge = document.createElement("span");
      badge.className = "gallery-badge";
      badge.textContent = "New";
      card.appendChild(badge);
    }

    const caption = document.createElement("span");
    caption.className = "gallery-caption";
    caption.textContent = item.name;
    card.appendChild(caption);

    card.addEventListener("click", () => pickGalleryItem(item, card));
    galleryGrid.appendChild(card);
  });

  galleryMore.hidden = galleryExpanded || galleryItems.length <= GALLERY_VISIBLE;
  galleryEl.classList.toggle("is-empty", galleryItems.length === 0);
}

async function pickGalleryItem(item, card) {
  if (card.disabled) return;
  galleryGrid.querySelectorAll("button").forEach((b) => (b.disabled = true));
  clearError();
  try {
    const response = await fetch(item.url);
    if (!response.ok) throw new Error("fetch failed");
    const blob = await response.blob();
    const name = item.url.split("/").pop();
    const file = new File([blob], name, { type: blob.type || "image/jpeg" });
    await handleFile(file, { save: false, exact: true });
  } catch {
    showError("Could not open that picture. Please try another one.");
  } finally {
    galleryGrid.querySelectorAll("button").forEach((b) => (b.disabled = false));
  }
}

galleryMore.addEventListener("click", () => {
  galleryExpanded = true;
  renderGallery();
});

loadGallery();

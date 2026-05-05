const uploadPanel = document.querySelector("#uploadPanel");
const sketchView = document.querySelector("#sketchView");
const dropZone = document.querySelector("#dropZone");
const imageInput = document.querySelector("#imageInput");
const loadingState = document.querySelector("#loadingState");
const resultView = document.querySelector("#resultView");
const originalImage = document.querySelector("#originalImage");
const sketchOriginalImage = document.querySelector("#sketchOriginalImage");
const generatedImage = document.querySelector("#generatedImage");
const storyText = document.querySelector("#storyText");
const errorMessage = document.querySelector("#errorMessage");
const changeImageButton = document.querySelector("#changeImageButton");
const replaceImageButton = document.querySelector("#replaceImageButton");
const drawToolButton = document.querySelector("#drawToolButton");
const eraseToolButton = document.querySelector("#eraseToolButton");
const resetSketchButton = document.querySelector("#resetSketchButton");
const generateButton = document.querySelector("#generateButton");
const sketchCanvas = document.querySelector("#sketchCanvas");
const sketchContext = sketchCanvas.getContext("2d", { willReadFrequently: true });

const SKETCH_SIZE = 768;
const PAPER_COLOR = "#f8f2dc";
const INK_COLOR = "#15120d";

let originalPreviewUrl = "";
let selectedFile = null;
let sourceImage = null;
let activeTool = "draw";
let isDrawing = false;
let lastPoint = null;

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
  if (file) {
    handleFile(file);
  }
});

imageInput.addEventListener("change", () => {
  const file = imageInput.files[0];
  if (file) {
    handleFile(file);
  }
});

changeImageButton.addEventListener("click", openImagePicker);
replaceImageButton.addEventListener("click", openImagePicker);

drawToolButton.addEventListener("click", () => setTool("draw"));
eraseToolButton.addEventListener("click", () => setTool("erase"));

resetSketchButton.addEventListener("click", () => {
  if (sourceImage) {
    drawAutoSketch(sourceImage);
  }
});

generateButton.addEventListener("click", generateFromSketch);

sketchCanvas.addEventListener("pointerdown", startDrawing);
sketchCanvas.addEventListener("pointermove", drawStroke);
sketchCanvas.addEventListener("pointerup", stopDrawing);
sketchCanvas.addEventListener("pointercancel", stopDrawing);
sketchCanvas.addEventListener("pointerleave", stopDrawing);

function openImagePicker() {
  imageInput.value = "";
  imageInput.click();
}

async function handleFile(file) {
  clearError();

  if (!file.type.startsWith("image/")) {
    showError("Please upload an image file.");
    return;
  }

  if (originalPreviewUrl) {
    URL.revokeObjectURL(originalPreviewUrl);
  }

  selectedFile = file;
  originalPreviewUrl = URL.createObjectURL(file);
  originalImage.src = originalPreviewUrl;
  sketchOriginalImage.src = originalPreviewUrl;

  try {
    sourceImage = await loadImage(originalPreviewUrl);
    drawAutoSketch(sourceImage);
    setTool("draw");
    setState("sketch");
  } catch {
    setState("upload");
    showError("The image could not be loaded.");
  }
}

async function generateFromSketch() {
  clearError();

  if (!selectedFile) {
    showError("Please upload an image first.");
    return;
  }

  setState("loading");

  const formData = new FormData();
  formData.append("image", selectedFile);
  formData.append("sketch", await canvasToBlob(sketchCanvas), "sketch.png");

  try {
    const response = await fetch("/api/transform-monument", {
      method: "POST",
      body: formData,
    });

    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.detail || "The transformation failed.");
    }

    storyText.textContent = payload.story;
    if (!payload.image_base64) {
      throw new Error("The server did not return a generated image.");
    }
    generatedImage.src = `data:image/png;base64,${payload.image_base64}`;
    setState("result");
  } catch (error) {
    setState("sketch");
    showError(error.message);
  }
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = reject;
    image.src = src;
  });
}

function drawAutoSketch(image) {
  sketchCanvas.width = SKETCH_SIZE;
  sketchCanvas.height = SKETCH_SIZE;

  const fit = getContainRect(image.width, image.height, SKETCH_SIZE, SKETCH_SIZE);
  sketchContext.fillStyle = PAPER_COLOR;
  sketchContext.fillRect(0, 0, SKETCH_SIZE, SKETCH_SIZE);
  sketchContext.drawImage(image, fit.x, fit.y, fit.width, fit.height);

  const imageData = sketchContext.getImageData(0, 0, SKETCH_SIZE, SKETCH_SIZE);
  const pixels = imageData.data;
  const gray = new Uint8ClampedArray(SKETCH_SIZE * SKETCH_SIZE);

  for (let index = 0; index < gray.length; index += 1) {
    const pixelIndex = index * 4;
    gray[index] = pixels[pixelIndex] * 0.299 + pixels[pixelIndex + 1] * 0.587 + pixels[pixelIndex + 2] * 0.114;
  }

  for (let y = 0; y < SKETCH_SIZE; y += 1) {
    for (let x = 0; x < SKETCH_SIZE; x += 1) {
      const pixelIndex = (y * SKETCH_SIZE + x) * 4;
      pixels[pixelIndex] = 248;
      pixels[pixelIndex + 1] = 242;
      pixels[pixelIndex + 2] = 220;
      pixels[pixelIndex + 3] = 255;
    }
  }

  for (let y = 1; y < SKETCH_SIZE - 1; y += 1) {
    for (let x = 1; x < SKETCH_SIZE - 1; x += 1) {
      const index = y * SKETCH_SIZE + x;
      const gx =
        -gray[index - SKETCH_SIZE - 1] -
        gray[index - 1] * 2 -
        gray[index + SKETCH_SIZE - 1] +
        gray[index - SKETCH_SIZE + 1] +
        gray[index + 1] * 2 +
        gray[index + SKETCH_SIZE + 1];
      const gy =
        -gray[index - SKETCH_SIZE - 1] -
        gray[index - SKETCH_SIZE] * 2 -
        gray[index - SKETCH_SIZE + 1] +
        gray[index + SKETCH_SIZE - 1] +
        gray[index + SKETCH_SIZE] * 2 +
        gray[index + SKETCH_SIZE + 1];
      const strength = Math.abs(gx) + Math.abs(gy);

      if (strength > 118) {
        const pixelIndex = index * 4;
        const ink = Math.max(18, 120 - strength * 0.15);
        pixels[pixelIndex] = ink;
        pixels[pixelIndex + 1] = ink;
        pixels[pixelIndex + 2] = ink;
      }
    }
  }

  sketchContext.putImageData(imageData, 0, 0);
}

function getContainRect(sourceWidth, sourceHeight, targetWidth, targetHeight) {
  const scale = Math.min(targetWidth / sourceWidth, targetHeight / sourceHeight);
  const width = sourceWidth * scale;
  const height = sourceHeight * scale;

  return {
    x: (targetWidth - width) / 2,
    y: (targetHeight - height) / 2,
    width,
    height,
  };
}

function setTool(tool) {
  activeTool = tool;
  drawToolButton.classList.toggle("is-active", tool === "draw");
  eraseToolButton.classList.toggle("is-active", tool === "erase");
}

function startDrawing(event) {
  event.preventDefault();
  isDrawing = true;
  lastPoint = getCanvasPoint(event);
  sketchCanvas.setPointerCapture(event.pointerId);
}

function drawStroke(event) {
  if (!isDrawing || !lastPoint) {
    return;
  }

  const point = getCanvasPoint(event);
  sketchContext.lineCap = "round";
  sketchContext.lineJoin = "round";
  sketchContext.lineWidth = activeTool === "erase" ? 34 : 8;
  sketchContext.strokeStyle = activeTool === "erase" ? PAPER_COLOR : INK_COLOR;
  sketchContext.beginPath();
  sketchContext.moveTo(lastPoint.x, lastPoint.y);
  sketchContext.lineTo(point.x, point.y);
  sketchContext.stroke();
  lastPoint = point;
}

function stopDrawing(event) {
  if (event.pointerId !== undefined && sketchCanvas.hasPointerCapture(event.pointerId)) {
    sketchCanvas.releasePointerCapture(event.pointerId);
  }
  isDrawing = false;
  lastPoint = null;
}

function getCanvasPoint(event) {
  const rect = sketchCanvas.getBoundingClientRect();
  return {
    x: ((event.clientX - rect.left) / rect.width) * sketchCanvas.width,
    y: ((event.clientY - rect.top) / rect.height) * sketchCanvas.height,
  };
}

function canvasToBlob(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) {
        resolve(blob);
      } else {
        reject(new Error("The sketch could not be prepared."));
      }
    }, "image/png");
  });
}

function setState(state) {
  uploadPanel.hidden = state !== "upload";
  sketchView.hidden = state !== "sketch";
  loadingState.hidden = state !== "loading";
  resultView.hidden = state !== "result";
}

function showError(message) {
  errorMessage.textContent = message;
  errorMessage.hidden = false;
}

function clearError() {
  errorMessage.textContent = "";
  errorMessage.hidden = true;
}

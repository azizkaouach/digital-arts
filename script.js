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
const sketchCanvas = document.querySelector("#sketchCanvas");
const sketchContext = sketchCanvas.getContext("2d", { willReadFrequently: true });

const SKETCH_SIZE = 768;
const PAPER_COLOR = "#fbf6e9";
const INK_COLOR = "#1c1a16";

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

colorCount.addEventListener("input", () => {
  colorCountValue.textContent = colorCount.value;
});

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

  if (originalPreviewUrl) URL.revokeObjectURL(originalPreviewUrl);

  selectedFile = file;
  originalPreviewUrl = URL.createObjectURL(file);
  originalImage.src = originalPreviewUrl;

  let sketchBlob = null;
  try {
    const sourceImage = await loadImage(originalPreviewUrl);
    drawAutoSketch(sourceImage);
    sketchBlob = await canvasToBlob(sketchCanvas);
  } catch {
    /* sketch is optional — continue without it */
  }

  await runGeneration(sketchBlob);
}

async function runGeneration(sketchBlob) {
  if (!selectedFile) return;

  setState("loading");

  const formData = new FormData();
  formData.append("image", selectedFile);
  if (sketchBlob) formData.append("sketch", sketchBlob, "sketch.png");
  formData.append("n_colors", colorCount.value);
  formData.append("want_story", wantStoryToggle.checked ? "true" : "false");

  try {
    const response = await fetch("/api/transform", {
      method: "POST",
      body: formData,
    });

    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.detail || "The transformation failed.");
    }
    if (!payload.image_base64) {
      throw new Error("The server did not return a coloring page.");
    }

    generatedImage.src = `data:image/png;base64,${payload.image_base64}`;
    renderLegend(payload.legend || []);
    renderStory(payload.story || "");
    renderAbout(payload.about || "");
    setState("result");
  } catch (error) {
    setState("upload");
    showError(error.message);
  }
}

function renderLegend(legend) {
  legendList.innerHTML = "";
  legend.forEach((entry) => {
    const li = document.createElement("li");
    li.className = "legend-item";

    const swatch = document.createElement("span");
    swatch.className = "legend-swatch";
    swatch.style.backgroundColor = entry.hex;
    swatch.textContent = entry.number;

    const meta = document.createElement("span");
    meta.className = "legend-meta";
    meta.innerHTML = `<strong>${entry.number}</strong><span>${entry.hex}</span>`;

    li.append(swatch, meta);
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
  const link = document.createElement("a");
  link.href = generatedImage.src;
  link.download = "coloring-page.png";
  document.body.append(link);
  link.click();
  link.remove();
}

function printPage() {
  if (!generatedImage.src) return;
  document.body.classList.add("is-printing");
  const cleanup = () => {
    document.body.classList.remove("is-printing");
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
    gray[index] =
      pixels[pixelIndex] * 0.299 +
      pixels[pixelIndex + 1] * 0.587 +
      pixels[pixelIndex + 2] * 0.114;
  }

  for (let y = 0; y < SKETCH_SIZE; y += 1) {
    for (let x = 0; x < SKETCH_SIZE; x += 1) {
      const pixelIndex = (y * SKETCH_SIZE + x) * 4;
      pixels[pixelIndex] = 251;
      pixels[pixelIndex + 1] = 246;
      pixels[pixelIndex + 2] = 233;
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

function canvasToBlob(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("The sketch could not be prepared."));
    }, "image/png");
  });
}

function setState(state) {
  uploadPanel.hidden = state !== "upload";
  optionsRow.hidden = state !== "upload";
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

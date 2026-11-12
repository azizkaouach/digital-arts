# Paint-by-Number Studio

Turn any photo into a friendly, numbered coloring page that kids can paint in.
Pick a picture from the gallery or upload one, paint it right in the browser,
then turn the finished painting into a 360° paper sculpture that comes alive.
The app also writes a coloring guide and a kid-friendly "Did you know?" card.

A Digital Arts Installation by Aziz, Thameur, Rayen and Faouzi.

---

## How it works

```
Pick a gallery picture or upload a photo (shrunk to 1400px in the browser)
        │
        ├──► POST /api/text      → Gemini Flash-Lite: coloring guide + fun facts (arrives later)
        │
        ▼
POST /api/transform (cached by image hash; gallery pages pre-built at startup)
   1. Resize to 1400px max side
   2. Sobel photo edges (in parallel with smoothing + KMeans)
   3. Median + Gaussian smoothing
   4. KMeans color quantization (4–16 colors)
   5. Merge tiny regions into their neighbour (vectorized)
   6. Trace region borders → black outlines
   7. Place each number at the region's pole of inaccessibility
   8. Return outline, numbers layer, combined page, answer key, legend
        │
        ▼
Frontend: outline + paint canvas + numbers layer on top, legend, Brush / Fill /
Eraser, Download (no numbers), Print (with numbers), 3D card (Three.js)
```

A page is ready in about 0.5–1 s for a new photo and about 0.15 s for a gallery
picture. The image pipeline is deterministic and runs locally with Pillow /
NumPy / SciPy / scikit-learn; no image AI is used. Gemini only writes the text.

---

## Project layout

| File / folder      | Role |
|--------------------|------|
| `main.py`          | FastAPI server: `/api/transform`, `/api/text`, `/api/gallery`, caching, gallery pre-warm |
| `coloring.py`      | Quantization, region cleanup, outlines, number placement, legend |
| `index.html`       | UI shell: upload, gallery, painting tools, result + legend |
| `script.js`        | Client logic: downscale + upload, gallery, painting tools, layers, download / print |
| `viewer3d.js/.css` | 360° paper-sculpture viewer with "comes alive" shaders (Three.js) |
| `style.css`        | Light "paper" theme, responsive layout, print stylesheet |
| `vendor/`          | Local copies of three.js r160 and OrbitControls (works offline) |
| `gallery/`         | Ready-made gallery photos; visitor uploads go to `gallery/uploads/` (gitignored) |
| `cache/`           | Disk cache of built pages and texts (gitignored, created on demand) |
| `requirements.txt` | Python dependencies |

---

## Setup

Requires Python 3.10+ and a Google Gemini API key.

```bash
# 1. Install dependencies
pip install -r requirements.txt

# 2. Configure the API key
echo GEMINI_API_KEY=your_key_here > .env

# 3. Run the server
uvicorn main:app --reload --port 8002
```

Then open [http://localhost:8002](http://localhost:8002).

### Optional environment variables

| Variable               | Default                    | Purpose                 |
| ---------------------- | -------------------------- | ----------------------- |
| `GEMINI_API_KEY`     | *(required)*             | Gemini auth             |
| `GEMINI_TEXT_MODEL`  | `gemini-2.5-flash-lite`  | Story generation model  |
| `GEMINI_IMAGE_MODEL` | `gemini-2.5-flash-image` | Flat illustration model |

---

## Using the app

1. **Pick** a picture from the gallery, or **upload** any photo.
2. Set the **number of colors** (6–16) and toggle the guide and fun facts.
3. **Paint**: tap a color in the guide, then use Fill (one tap per region),
   Brush or Eraser. The **Numbers** button hides or shows the numbers.
4. **Download** your painting (no numbers) or **Print** the numbered page on A4.
5. Press **3D card** to turn the painting into a 360° paper sculpture: drag to
   rotate, scroll to zoom, toggle Spin and Alive, and save a picture of it.

---

## API

### `POST /api/transform`

Multipart form fields:

| Field             | Type    | Required | Notes |
|-------------------|---------|----------|-------|
| `image`           | file    | yes      | Source photo |
| `n_colors`        | int     | no       | 4–16 (default 8; the UI sends 12) |
| `want_story`      | boolean | no       | default `true`; the UI sends `false` and calls `/api/text` in parallel |
| `save_to_gallery` | boolean | no       | default `true`; stores the upload in `gallery/uploads/` |

Response:

```json
{
  "story": "", "about": "", "text_rate_limited": false,
  "image_base64": "<png: outlines + numbers (for printing)>",
  "outline_base64": "<png: outlines only>",
  "numbers_base64": "<png rgba: numbers only, transparent background>",
  "preview_base64": "<png: the page fully painted (answer key)>",
  "legend": [{ "number": 1, "hex": "#ff7a59", "rgb": [255, 122, 89] }],
  "n_colors_used": 12
}
```

The legacy route `/api/transform-monument` is kept as an alias.

### `POST /api/text`

Field `image`. Returns `{ "story", "about" }`, or HTTP 429 while Gemini is rate
limited (the UI retries every 15 s). Successful texts are cached per image.

### `GET /api/gallery`

Returns `{ "items": [{ "url", "name", "kind": "upload" | "seed" }] }`, newest
uploads first.

---

## Tuning

Tweak constants in `coloring.py`:

| Constant                | Default  | Effect |
|-------------------------|----------|--------|
| `PAGE_SIZE`             | `1400`   | Output resolution |
| `KMEANS_FIT_SIZE`       | `160`    | Downsample size for KMeans (speed vs. fidelity) |
| `MIN_REGION_AREA_RATIO` | `0.0008` | Smaller regions get merged into a neighbour |
| `MIN_NUMBER_AREA_RATIO` | `0.0005` | Regions smaller than this don't get a printed number |
| `PNG_COMPRESS_LEVEL`    | `6`      | PNG size vs. encoding time |

If a busy photo gives a noisy page, raise `MIN_REGION_AREA_RATIO` or lower
`n_colors`. Delete `cache/` after changing any of these.

---

## Known limits

- Very busy photos (crowds, dense foliage, ruins) posterize into many small
  regions; simple subjects make the nicest pages.
- The 3D sculpture orders layers by color area, so small details stand tallest.
  It has been tested in headless Chromium only; check frame rate on the demo
  laptop's GPU.
- KMeans is seeded (`random_state=0`), so the same photo always gives the same page.

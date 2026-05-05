# Paint-by-Number Studio

Turn any photo into a friendly, numbered coloring page that kids can paint in.
Upload a picture, optionally sketch a few guide lines over it, and the app
returns a printable paint-by-number page with a matching color legend and a
short kid-friendly story.

A Digital Arts Installation by Aziz, Thameur, Rayen and Faouzi.

---

## How it works

```
Upload photo
        │
        ├──► Gemini text  → 3-sentence kid story (free tier)
        │
        ▼
Server post-processing (Pillow + NumPy + SciPy + scikit-learn)
   1. Resize to a printable square (1200×1200)
   2. Median + Gaussian smoothing (merges noise into solid regions)
   3. KMeans color quantization (4–12 colors)
   4. Connected-component region labeling
   5. Drop tiny regions into their largest neighbour
   6. Trace region borders → black outlines
   7. Place a color number at each region's centroid
   8. Build a color legend (number → swatch + hex)
        │
        ▼
Frontend renders: outline PNG + legend chips + story + Download / Print
```

The image pipeline is fully deterministic and runs locally with Pillow / NumPy
/ SciPy / scikit-learn — no paid AI calls, no quota limits, no key required.
Gemini is only used for the optional kid-friendly story (covered by the free
tier).

---

## Project layout

| File              | Role |
|-------------------|------|
| `main.py`         | FastAPI server, Gemini prompts, `/api/transform` endpoint |
| `coloring.py`     | Quantization, region cleanup, outline tracing, number placement, legend |
| `index.html`      | UI shell — upload, sketch canvas, result + legend |
| `script.js`       | Client logic — sketch tools, form upload, legend rendering, download / print |
| `style.css`       | Light "paper" theme + responsive layout + print stylesheet |
| `requirements.txt`| Python dependencies |

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

Then open <http://localhost:8002>.

### Optional environment variables

| Variable              | Default                       | Purpose |
|-----------------------|-------------------------------|---------|
| `GEMINI_API_KEY`      | *(required)*                  | Gemini auth |
| `GEMINI_TEXT_MODEL`   | `gemini-2.5-flash-lite`       | Story generation model |
| `GEMINI_IMAGE_MODEL`  | `gemini-2.5-flash-image`      | Flat illustration model |

---

## Using the app

1. **Upload** any photo (animal, monument, person, scene…).
2. *(Optional)* Sketch over the auto-generated edge guide to nudge composition.
3. Pick the **number of colors** (4–12). Lower = simpler page.
4. Toggle the **story** on or off.
5. Hit **Make my coloring page**.
6. **Download** as PNG or **Print** straight to A4 (the print stylesheet hides
   chrome and lays out the coloring page + legend on a single page).

---

## API

### `POST /api/transform`

Multipart form fields:

| Field        | Type    | Required | Notes |
|--------------|---------|----------|-------|
| `image`      | file    | yes      | Source photo |
| `sketch`     | file    | no       | PNG sketch from the canvas |
| `n_colors`   | int     | no       | 4–12, default 8 |
| `want_story` | boolean | no       | default `true` |

Response:

```json
{
  "story": "Once upon a time…",
  "image_base64": "<png base64 — paint-by-number page>",
  "preview_base64": "<png base64 — Gemini's flat illustration>",
  "legend": [{ "number": 1, "hex": "#ff7a59", "rgb": [255, 122, 89] }],
  "n_colors_used": 7
}
```

The legacy route `/api/transform-monument` is kept as an alias of `/api/transform`.

---

## Tuning

Tweak constants in `coloring.py`:

| Constant                | Default | Effect |
|-------------------------|---------|--------|
| `PAGE_SIZE`             | `1200`  | Output resolution |
| `KMEANS_FIT_SIZE`       | `200`   | Downsample size for KMeans (speed vs. fidelity) |
| `MIN_REGION_AREA_RATIO` | `0.0015`| Smaller regions get merged into a neighbour |
| `MIN_NUMBER_AREA_RATIO` | `0.004` | Regions smaller than this don't get a printed number |

If Gemini returns a shaded result and the page looks noisy, raise
`MIN_REGION_AREA_RATIO` to `0.003` or lower `n_colors`.

---

## Known limits

- Output quality depends on Gemini producing a flat illustration. Photos with
  lots of fine detail (busy crowds, complex foliage) sometimes posterize into
  too many small regions; bumping the cleanup threshold helps.
- Number placement uses each region's centroid — for U- or C-shaped regions
  the centroid can fall outside the shape. Future work: replace with a
  pole-of-inaccessibility computation.
- KMeans is non-deterministic across runs (random init); seeded to `0` here for
  consistency.

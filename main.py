import asyncio
import hashlib
import io
import json
import logging
import os
import secrets
import threading
from collections import OrderedDict
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path

from google import genai
from google.genai import types
from dotenv import load_dotenv
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from PIL import Image
from starlette.concurrency import run_in_threadpool

from coloring import build_coloring_page, clamp_colors


load_dotenv(override=True)

BASE_DIR = Path(__file__).resolve().parent
GALLERY_DIR = BASE_DIR / "gallery"
UPLOADS_DIR = GALLERY_DIR / "uploads"
CACHE_DIR = BASE_DIR / "cache"
IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".webp"}
DEFAULT_N_COLORS = 12  # what the frontend asks for; gallery seeds are pre-built with it
COLORING_CACHE_SIZE = 32
logger = logging.getLogger("paint-studio")
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY")

TEXT_MODEL = os.getenv("GEMINI_TEXT_MODEL", os.getenv("GEMINI_MODEL", "gemini-2.5-flash-lite"))

STORY_PROMPT = (
    "Look closely at this picture. Write ONE warm, friendly paragraph of about "
    "6 to 8 sentences for a child who is going to color this picture. "
    "First, name what you see in the picture in a clear way. Then walk the child "
    "through the main parts of the picture and clearly suggest a color for each "
    "one (for example: 'the sky is a soft baby blue', 'the leaves are bright "
    "green', 'the roof is warm red', 'the windows are sunny yellow'). Mention "
    "small details too so nothing is missed. Use simple, kind words. Do not "
    "include a title, headings, lists, or markdown. Just one flowing paragraph."
)
ABOUT_PROMPT = (
    "Identify the main subject of this picture (for example: a famous monument, "
    "an animal, a place, a vehicle). Then write a short, fun, educational "
    "paragraph of 4 to 6 sentences about it for a curious 6-to-9-year-old child. "
    "Start with the subject's name in bold-free plain text. Include where it is "
    "or where it is found, why it is special, and one or two amazing facts a "
    "child would love to know (for example: how tall it is, when it was built, "
    "what it is used for, fun details). Use simple, kind, exciting words. Do "
    "NOT include a title, headings, lists, markdown, or quotation marks. Just "
    "one flowing paragraph."
)

RATE_LIMITED_TEXT = "Waiting for AI to rest... Facts will appear shortly!"
FAILED_TEXT = "Hmm, we couldn't think of a story right now. Try another picture!"

gemini_client = genai.Client(api_key=GEMINI_API_KEY) if GEMINI_API_KEY else None


# --- Caches: coloring pages (memory LRU + cache/*.json) and Gemini texts (cache/*.json) ---------

_coloring_lru: "OrderedDict[str, dict]" = OrderedDict()
_cache_lock = threading.Lock()
_build_locks: dict[str, threading.Lock] = {}


def _digest(image_bytes: bytes) -> str:
    return hashlib.sha256(image_bytes).hexdigest()


def _read_json(path: Path) -> dict | None:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return None
    except Exception:
        logger.warning("Ignoring unreadable cache file %s", path.name)
        return None


def _write_json(path: Path, data: dict) -> None:
    """Best-effort atomic write; a disk problem must never break a request."""
    try:
        CACHE_DIR.mkdir(exist_ok=True)
        tmp = path.with_name(f"{path.name}.{secrets.token_hex(4)}.tmp")
        tmp.write_text(json.dumps(data), encoding="utf-8")
        os.replace(tmp, path)
    except Exception:
        logger.warning("Could not write cache file %s", path.name, exc_info=True)


def get_coloring(image_bytes: bytes, n_colors: int) -> dict:
    """Coloring page fields for this photo, from memory, disk or a fresh build (blocking)."""
    key = f"{_digest(image_bytes)}-{clamp_colors(n_colors)}"
    with _cache_lock:
        hit = _coloring_lru.get(key)
        if hit is not None:
            _coloring_lru.move_to_end(key)
            return hit
        build_lock = _build_locks.setdefault(key, threading.Lock())

    with build_lock:  # a request and the gallery pre-warm for the same photo build it once
        with _cache_lock:
            hit = _coloring_lru.get(key)
        if hit is None:
            path = CACHE_DIR / f"coloring-{key}.json"
            hit = _read_json(path)
            if hit is None or "numbers_base64" not in hit:
                result = build_coloring_page(image_bytes, n_colors)
                hit = {
                    "image_base64": result.page_png_b64,
                    "outline_base64": result.outline_png_b64,
                    "numbers_base64": result.numbers_png_b64,
                    "preview_base64": result.preview_png_b64,
                    "legend": result.legend,
                    "n_colors_used": result.n_colors_used,
                }
                _write_json(path, hit)
            with _cache_lock:
                _coloring_lru[key] = hit
                while len(_coloring_lru) > COLORING_CACHE_SIZE:
                    _coloring_lru.popitem(last=False)
    return hit


def prewarm_gallery() -> None:
    """Build and cache the page for every gallery seed so picking one is instant."""
    if not GALLERY_DIR.is_dir():
        return
    seeds = [f for f in GALLERY_DIR.iterdir() if f.is_file() and f.suffix.lower() in IMAGE_EXTS]
    for seed in sorted(seeds, key=lambda f: f.name.lower()):
        try:
            get_coloring(seed.read_bytes(), DEFAULT_N_COLORS)
        except Exception:
            logger.exception("Could not pre-warm %s", seed.name)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    threading.Thread(target=prewarm_gallery, name="gallery-prewarm", daemon=True).start()
    yield


app = FastAPI(
    title="Paint-by-Number Studio",
    description="Turns any photo into a guided coloring page for kids.",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/", include_in_schema=False)
def serve_index():
    return FileResponse(BASE_DIR / "index.html")


@app.get("/style.css", include_in_schema=False)
def serve_css():
    return FileResponse(BASE_DIR / "style.css")


@app.get("/script.js", include_in_schema=False)
def serve_js():
    return FileResponse(BASE_DIR / "script.js")


@app.get("/viewer3d.js", include_in_schema=False)
def serve_viewer3d_js():
    return FileResponse(BASE_DIR / "viewer3d.js", media_type="text/javascript")


@app.get("/viewer3d.css", include_in_schema=False)
def serve_viewer3d_css():
    return FileResponse(BASE_DIR / "viewer3d.css")


@app.get("/api/gallery")
def list_gallery():
    items = []
    if UPLOADS_DIR.is_dir():
        uploads = [f for f in UPLOADS_DIR.iterdir() if f.is_file() and f.suffix.lower() in IMAGE_EXTS]
        uploads.sort(key=lambda f: f.stat().st_mtime, reverse=True)
        for f in uploads:
            items.append({
                "url": f"/gallery/uploads/{f.name}",
                "name": "Upload",
                "kind": "upload",
                "added": datetime.fromtimestamp(f.stat().st_mtime, timezone.utc).isoformat(),
            })
    if GALLERY_DIR.is_dir():
        seeds = [f for f in GALLERY_DIR.iterdir() if f.is_file() and f.suffix.lower() in IMAGE_EXTS]
        for f in sorted(seeds, key=lambda f: f.name.lower()):
            items.append({
                "url": f"/gallery/{f.name}",
                "name": f.stem.replace("-", " ").replace("_", " ").title(),
                "kind": "seed",
            })
    return {"items": items}


def save_upload_to_gallery(image_bytes: bytes, mime_type: str) -> None:
    """Best-effort: store the original upload; never raises."""
    try:
        UPLOADS_DIR.mkdir(parents=True, exist_ok=True)
        ext = {"image/jpeg": "jpg", "image/jpg": "jpg", "image/png": "png", "image/webp": "webp"}.get(mime_type)
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        path = UPLOADS_DIR / f"upload-{stamp}-{secrets.token_hex(2)}.{ext or 'jpg'}"
        if ext:
            path.write_bytes(image_bytes)
        else:
            with Image.open(io.BytesIO(image_bytes)) as im:
                im.convert("RGB").save(path, "JPEG", quality=90)
    except Exception:
        logger.exception("Could not save upload to gallery")


@app.post("/api/transform")
@app.post("/api/transform-monument")
async def transform(
    image: UploadFile = File(...),
    sketch: UploadFile | None = File(None),
    n_colors: int = Form(8),
    want_story: bool = Form(True),
    save_to_gallery: bool = Form(True),
):
    if not image.content_type or not image.content_type.startswith("image/"):
        raise HTTPException(status_code=400, detail="Please upload a valid image file.")

    image_bytes = await image.read()
    if not image_bytes:
        raise HTTPException(status_code=400, detail="The uploaded image is empty.")

    if sketch is not None:
        await sketch.read()  # consumed but no longer used

    try:
        coloring_task = run_in_threadpool(get_coloring, image_bytes, n_colors)
        if want_story:  # kept for older clients; the frontend uses /api/text instead
            coloring, (story, about, text_limited) = await asyncio.gather(
                coloring_task, get_texts(image_bytes, image.content_type)
            )
        else:
            coloring = await coloring_task
            story, about, text_limited = "", "", False
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(
            status_code=502,
            detail=f"Could not build the coloring page: {exc}",
        ) from exc

    if save_to_gallery:
        await run_in_threadpool(save_upload_to_gallery, image_bytes, image.content_type)

    return {
        "story": story,
        "about": about,
        "text_rate_limited": text_limited,
        **coloring,
    }


async def _maybe_text(enabled: bool, prompt: str, image_bytes: bytes, mime_type: str) -> tuple[str, bool]:
    if not enabled or gemini_client is None:
        return "", False
    try:
        text = await run_in_threadpool(generate_text, prompt, image_bytes, mime_type)
        return text, False
    except Exception as e:
        if "429" in str(e):
            return RATE_LIMITED_TEXT, True
        return FAILED_TEXT, False


def generate_text(prompt: str, image_bytes: bytes, mime_type: str) -> str:
    response = gemini_client.models.generate_content(
        model=TEXT_MODEL,
        contents=[
            prompt,
            types.Part.from_bytes(data=image_bytes, mime_type=mime_type),
        ],
    )
    text = getattr(response, "text", "").strip()
    if not text:
        raise RuntimeError("Gemini returned an empty response.")
    return text


async def get_texts(image_bytes: bytes, mime_type: str) -> tuple[str, str, bool]:
    """(story, about, rate_limited) for the photo; good answers are cached on disk by its hash."""
    path = CACHE_DIR / f"text-{_digest(image_bytes)}.json"
    cached = await run_in_threadpool(_read_json, path)
    if cached and cached.get("story") and cached.get("about"):
        return cached["story"], cached["about"], False

    story_res, about_res = await asyncio.gather(
        _maybe_text(True, STORY_PROMPT, image_bytes, mime_type),
        _maybe_text(True, ABOUT_PROMPT, image_bytes, mime_type),
    )
    story, story_limited = story_res
    about, about_limited = about_res
    if not (story_limited or about_limited) and story and about and FAILED_TEXT not in (story, about):
        await run_in_threadpool(_write_json, path, {"story": story, "about": about})
    return story, about, story_limited or about_limited


@app.post("/api/text")
async def generate_texts_api(
    image: UploadFile = File(...),
):
    if not image.content_type or not image.content_type.startswith("image/"):
        raise HTTPException(status_code=400, detail="Invalid image")

    image_bytes = await image.read()
    if not image_bytes:
        raise HTTPException(status_code=400, detail="Empty image")

    story, about, limited = await get_texts(image_bytes, image.content_type)
    if limited:
        raise HTTPException(status_code=429, detail="Rate limited")

    return {
        "story": story,
        "about": about,
    }


GALLERY_DIR.mkdir(exist_ok=True)
app.mount("/vendor", StaticFiles(directory=BASE_DIR / "vendor", check_dir=False), name="vendor")
app.mount("/gallery", StaticFiles(directory=GALLERY_DIR), name="gallery")

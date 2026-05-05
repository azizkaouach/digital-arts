import base64
import os
from pathlib import Path

from google import genai
from google.genai import types
from dotenv import load_dotenv
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from starlette.concurrency import run_in_threadpool

from coloring import build_coloring_page


load_dotenv()

BASE_DIR = Path(__file__).resolve().parent
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY")

TEXT_MODEL = os.getenv("GEMINI_TEXT_MODEL", os.getenv("GEMINI_MODEL", "gemini-2.5-flash-lite"))
IMAGE_MODEL = os.getenv("GEMINI_IMAGE_MODEL", "gemini-2.5-flash-image")

STORY_PROMPT = (
    "Look at this picture. Write a 3-sentence, simple, warm, and friendly story "
    "for a 6-year-old child about what is in the picture. Do not use difficult "
    "words. Do not include a title."
)
IMAGE_PROMPT = (
    "Redraw the main subject of this photo as a flat, simple 2D illustration. "
    "Use ONLY about 6 to 8 large solid color shapes. NO shading, NO gradients, "
    "NO texture, NO patterns, NO outlines, NO text, NO labels, NO logos. "
    "Make the shapes big, clean, and easy for a 6-year-old to recognize. "
    "Use a plain white or single-color background. "
    "If a sketch is provided, follow its composition. Return one finished image."
)

gemini_client = genai.Client(api_key=GEMINI_API_KEY) if GEMINI_API_KEY else None


app = FastAPI(
    title="Paint-by-Number Studio",
    description="Turns any photo into a guided coloring page for kids.",
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


@app.post("/api/transform")
@app.post("/api/transform-monument")
async def transform(
    image: UploadFile = File(...),
    sketch: UploadFile | None = File(None),
    n_colors: int = Form(8),
    want_story: bool = Form(True),
):
    if gemini_client is None:
        raise HTTPException(
            status_code=500,
            detail="GEMINI_API_KEY is missing. Add it to your .env file.",
        )

    if not image.content_type or not image.content_type.startswith("image/"):
        raise HTTPException(status_code=400, detail="Please upload a valid image file.")

    image_bytes = await image.read()
    if not image_bytes:
        raise HTTPException(status_code=400, detail="The uploaded image is empty.")

    sketch_bytes = b""
    sketch_content_type = ""
    if sketch is not None:
        if not sketch.content_type or not sketch.content_type.startswith("image/"):
            raise HTTPException(status_code=400, detail="Please upload a valid sketch image.")
        sketch_bytes = await sketch.read()
        sketch_content_type = sketch.content_type

    try:
        story = ""
        if want_story:
            story = await run_in_threadpool(
                generate_child_story,
                image_bytes,
                image.content_type,
            )

        flat_image_bytes = await run_in_threadpool(
            generate_flat_illustration,
            story,
            image_bytes,
            image.content_type,
            sketch_bytes,
            sketch_content_type,
        )

        coloring = await run_in_threadpool(
            build_coloring_page,
            flat_image_bytes,
            n_colors,
        )
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(
            status_code=502,
            detail=f"The AI transformation failed: {exc}",
        ) from exc

    return {
        "story": story,
        "image_base64": coloring.page_png_b64,
        "preview_base64": coloring.preview_png_b64,
        "legend": coloring.legend,
        "n_colors_used": coloring.n_colors_used,
    }


def generate_child_story(image_bytes: bytes, mime_type: str) -> str:
    response = gemini_client.models.generate_content(
        model=TEXT_MODEL,
        contents=[
            STORY_PROMPT,
            types.Part.from_bytes(data=image_bytes, mime_type=mime_type),
        ],
    )
    story = getattr(response, "text", "").strip()
    if not story:
        raise RuntimeError("Gemini returned an empty story.")
    return story


def generate_flat_illustration(
    story: str,
    image_bytes: bytes,
    image_mime_type: str,
    sketch_bytes: bytes,
    sketch_mime_type: str,
) -> bytes:
    prompt = f"{story}\n\n{IMAGE_PROMPT}" if story else IMAGE_PROMPT
    contents = [
        prompt,
        types.Part.from_bytes(data=image_bytes, mime_type=image_mime_type),
    ]
    if sketch_bytes:
        contents.append(types.Part.from_bytes(data=sketch_bytes, mime_type=sketch_mime_type))

    response = gemini_client.models.generate_content(
        model=IMAGE_MODEL,
        contents=contents,
        config=types.GenerateContentConfig(response_modalities=["TEXT", "IMAGE"]),
    )

    for part in response_parts(response):
        inline_data = getattr(part, "inline_data", None)
        if inline_data and inline_data.data:
            data = inline_data.data
            if isinstance(data, str):
                return base64.b64decode(data)
            return data

    response_text = getattr(response, "text", "").strip()
    detail = f" Gemini said: {response_text}" if response_text else ""
    raise RuntimeError(f"Gemini did not return an image.{detail}")


def response_parts(response):
    direct_parts = getattr(response, "parts", None)
    if direct_parts:
        return direct_parts
    candidates = getattr(response, "candidates", None) or []
    if not candidates:
        return []
    content = getattr(candidates[0], "content", None)
    return getattr(content, "parts", None) or []

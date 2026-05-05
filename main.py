import base64
import os
from pathlib import Path

from google import genai
from google.genai import types
from dotenv import load_dotenv
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from starlette.concurrency import run_in_threadpool


load_dotenv()

BASE_DIR = Path(__file__).resolve().parent
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY")

TEXT_MODEL = os.getenv("GEMINI_TEXT_MODEL", os.getenv("GEMINI_MODEL", "gemini-2.5-flash-lite"))
IMAGE_MODEL = os.getenv("GEMINI_IMAGE_MODEL", "gemini-2.5-flash-image")
STORY_PROMPT = (
    "Identify this historical monument. Write a 3-sentence, highly simplified, "
    "and engaging story about it meant for a 6-year-old child."
)
IMAGE_PROMPT = (
    "Create a child-like, colorful, simple 2D illustration of the monument. "
    "Use the uploaded photo for the monument identity and the sketch for the "
    "main shapes and composition. Make it innocent, bright, readable, and "
    "friendly for a 6-year-old. Do not add text, labels, logos, or captions. "
    "Return one finished image."
)

gemini_client = genai.Client(api_key=GEMINI_API_KEY) if GEMINI_API_KEY else None


app = FastAPI(
    title="Machine Innocence: Algorithmic Reductionism",
    description="Transforms monument photos into simplified stories and illustrations.",
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


@app.post("/api/transform-monument")
async def transform_monument(
    image: UploadFile = File(...),
    sketch: UploadFile | None = File(None),
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
        story = await run_in_threadpool(
            generate_child_story,
            image_bytes,
            image.content_type,
        )
        image_base64 = await run_in_threadpool(
            generate_gemini_illustration,
            story,
            image_bytes,
            image.content_type,
            sketch_bytes,
            sketch_content_type,
        )
    except Exception as exc:
        raise HTTPException(
            status_code=502,
            detail=f"The AI transformation failed: {exc}",
        ) from exc

    return {
        "story": story,
        "image_base64": image_base64,
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


def generate_gemini_illustration(
    story: str,
    image_bytes: bytes,
    image_mime_type: str,
    sketch_bytes: bytes,
    sketch_mime_type: str,
) -> str:
    contents = [
        f"{story}\n\n{IMAGE_PROMPT}",
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
            image_data = inline_data.data
            if isinstance(image_data, str):
                return image_data

            return base64.b64encode(image_data).decode("utf-8")

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

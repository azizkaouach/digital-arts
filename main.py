import asyncio
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
    if not image.content_type or not image.content_type.startswith("image/"):
        raise HTTPException(status_code=400, detail="Please upload a valid image file.")

    image_bytes = await image.read()
    if not image_bytes:
        raise HTTPException(status_code=400, detail="The uploaded image is empty.")

    if sketch is not None:
        await sketch.read()  # consumed but no longer used

    try:
        story_task = _maybe_text(want_story, STORY_PROMPT, image_bytes, image.content_type)
        about_task = _maybe_text(want_story, ABOUT_PROMPT, image_bytes, image.content_type)

        coloring_task = run_in_threadpool(build_coloring_page, image_bytes, n_colors)

        story, about, coloring = await asyncio.gather(story_task, about_task, coloring_task)
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(
            status_code=502,
            detail=f"Could not build the coloring page: {exc}",
        ) from exc

    return {
        "story": story,
        "about": about,
        "image_base64": coloring.page_png_b64,
        "preview_base64": coloring.preview_png_b64,
        "legend": coloring.legend,
        "n_colors_used": coloring.n_colors_used,
    }


async def _maybe_text(enabled: bool, prompt: str, image_bytes: bytes, mime_type: str) -> str:
    if not enabled or gemini_client is None:
        return ""
    try:
        return await run_in_threadpool(generate_text, prompt, image_bytes, mime_type)
    except Exception:
        return ""


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



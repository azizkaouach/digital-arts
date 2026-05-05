"""Turn a flat illustration into a paint-by-number coloring page."""

from __future__ import annotations

import base64
import io
from dataclasses import dataclass
from typing import List, Tuple

import numpy as np
from PIL import Image, ImageDraw, ImageFont
from scipy import ndimage
from sklearn.cluster import KMeans

PAGE_SIZE = 1200
KMEANS_FIT_SIZE = 200
MIN_REGION_AREA_RATIO = 0.0015
MIN_NUMBER_AREA_RATIO = 0.004
OUTLINE_RGB = (20, 20, 20)
PAGE_BG = (255, 255, 255)


@dataclass
class ColoringResult:
    page_png_b64: str
    preview_png_b64: str
    legend: List[dict]
    n_colors_used: int


def build_coloring_page(image_bytes: bytes, n_colors: int = 8) -> ColoringResult:
    n_colors = max(4, min(12, int(n_colors)))

    pil = Image.open(io.BytesIO(image_bytes)).convert("RGB")
    pil = _fit_square(pil, PAGE_SIZE)
    rgb = np.asarray(pil, dtype=np.uint8)

    labels, palette = _posterize(rgb, n_colors)
    labels = _clean_regions(labels, int(MIN_REGION_AREA_RATIO * labels.size))

    used_color_ids = sorted(int(c) for c in np.unique(labels))
    color_id_to_number = {cid: idx + 1 for idx, cid in enumerate(used_color_ids)}

    preview_img = Image.fromarray(palette[labels].astype(np.uint8), mode="RGB")
    page_img = _render_page(labels, color_id_to_number)

    legend = [
        {
            "number": color_id_to_number[cid],
            "hex": "#{:02x}{:02x}{:02x}".format(*palette[cid].astype(int)),
            "rgb": [int(v) for v in palette[cid]],
        }
        for cid in used_color_ids
    ]

    return ColoringResult(
        page_png_b64=_encode_png(page_img),
        preview_png_b64=_encode_png(preview_img),
        legend=legend,
        n_colors_used=len(used_color_ids),
    )


def _fit_square(img: Image.Image, size: int) -> Image.Image:
    canvas = Image.new("RGB", (size, size), PAGE_BG)
    src = img.copy()
    src.thumbnail((size, size), Image.LANCZOS)
    canvas.paste(src, ((size - src.width) // 2, (size - src.height) // 2))
    return canvas


def _posterize(rgb: np.ndarray, n_colors: int) -> Tuple[np.ndarray, np.ndarray]:
    h, w, _ = rgb.shape
    fit_img = Image.fromarray(rgb).resize((KMEANS_FIT_SIZE, KMEANS_FIT_SIZE), Image.LANCZOS)
    fit_pixels = np.asarray(fit_img, dtype=np.float32).reshape(-1, 3)

    km = KMeans(n_clusters=n_colors, n_init=4, random_state=0)
    km.fit(fit_pixels)
    palette = km.cluster_centers_.astype(np.float32)

    full_pixels = rgb.reshape(-1, 3).astype(np.float32)
    labels = km.predict(full_pixels).reshape(h, w).astype(np.int32)

    return labels, palette


def _clean_regions(labels: np.ndarray, min_area: int) -> np.ndarray:
    cleaned = labels.copy()
    changed = True
    iterations = 0

    while changed and iterations < 4:
        changed = False
        iterations += 1
        for color_id in np.unique(cleaned):
            mask = cleaned == color_id
            comp, n_comp = ndimage.label(mask)
            if n_comp == 0:
                continue
            sizes = ndimage.sum(mask, comp, index=range(1, n_comp + 1))
            for region_idx, area in enumerate(sizes, start=1):
                if area >= min_area:
                    continue
                region_mask = comp == region_idx
                neighbour = _dominant_neighbour(cleaned, region_mask, exclude=color_id)
                if neighbour is None:
                    continue
                cleaned[region_mask] = neighbour
                changed = True

    return cleaned


def _dominant_neighbour(labels: np.ndarray, region_mask: np.ndarray, exclude: int) -> int | None:
    dilated = ndimage.binary_dilation(region_mask)
    border = dilated & ~region_mask
    neighbour_labels = labels[border]
    neighbour_labels = neighbour_labels[neighbour_labels != exclude]
    if neighbour_labels.size == 0:
        return None
    values, counts = np.unique(neighbour_labels, return_counts=True)
    return int(values[counts.argmax()])


def _render_page(labels: np.ndarray, color_id_to_number: dict) -> Image.Image:
    h, w = labels.shape
    edges = _edge_mask(labels)
    canvas = np.empty((h, w, 3), dtype=np.uint8)
    canvas[..., :] = PAGE_BG
    canvas[edges] = OUTLINE_RGB
    page = Image.fromarray(canvas, mode="RGB")
    draw = ImageDraw.Draw(page)

    min_number_area = MIN_NUMBER_AREA_RATIO * labels.size

    for color_id in np.unique(labels):
        mask = labels == color_id
        comp, n_comp = ndimage.label(mask)
        if n_comp == 0:
            continue
        sizes = ndimage.sum(mask, comp, index=range(1, n_comp + 1))
        centroids = ndimage.center_of_mass(mask, comp, index=range(1, n_comp + 1))
        number = color_id_to_number[int(color_id)]

        for area, (cy, cx) in zip(sizes, centroids):
            if area < min_number_area:
                continue
            font = _font_for_area(area)
            text = str(number)
            bbox = draw.textbbox((0, 0), text, font=font)
            tw = bbox[2] - bbox[0]
            th = bbox[3] - bbox[1]
            draw.text((cx - tw / 2, cy - th / 2), text, fill=OUTLINE_RGB, font=font)

    return page


def _edge_mask(labels: np.ndarray) -> np.ndarray:
    diff_x = np.zeros_like(labels, dtype=bool)
    diff_y = np.zeros_like(labels, dtype=bool)
    diff_x[:, 1:] = labels[:, 1:] != labels[:, :-1]
    diff_y[1:, :] = labels[1:, :] != labels[:-1, :]
    edges = diff_x | diff_y
    edges[0, :] = True
    edges[-1, :] = True
    edges[:, 0] = True
    edges[:, -1] = True
    return ndimage.binary_dilation(edges, iterations=1)


def _font_for_area(area: float) -> ImageFont.ImageFont:
    radius = float(np.sqrt(area / np.pi))
    size = int(max(12, min(48, radius * 0.55)))
    for candidate in ("arial.ttf", "DejaVuSans.ttf", "Helvetica.ttc"):
        try:
            return ImageFont.truetype(candidate, size=size)
        except OSError:
            continue
    return ImageFont.load_default()


def _encode_png(img: Image.Image) -> str:
    buffer = io.BytesIO()
    img.save(buffer, format="PNG", optimize=True)
    return base64.b64encode(buffer.getvalue()).decode("utf-8")

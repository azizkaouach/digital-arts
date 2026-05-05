"""Turn a photo into a paint-by-number coloring page that stays close to the original."""

from __future__ import annotations

import base64
import io
from dataclasses import dataclass
from typing import List, Tuple

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont
from scipy import ndimage
from sklearn.cluster import KMeans

PAGE_SIZE = 1400
KMEANS_FIT_SIZE = 240
SMOOTH_RADIUS = 1.4
MEDIAN_SIZE = 3
PHOTO_EDGE_THRESHOLD = 70
MIN_REGION_AREA_RATIO = 0.0008
MIN_NUMBER_AREA_RATIO = 0.0025
OUTLINE_RGB = (15, 15, 15)
PAGE_BG = (255, 255, 255)


@dataclass
class ColoringResult:
    page_png_b64: str
    preview_png_b64: str
    legend: List[dict]
    n_colors_used: int


def build_coloring_page(image_bytes: bytes, n_colors: int = 10) -> ColoringResult:
    n_colors = max(4, min(16, int(n_colors)))

    pil = Image.open(io.BytesIO(image_bytes)).convert("RGB")
    pil = _fit_square(pil, PAGE_SIZE)
    sharp_rgb = np.asarray(pil, dtype=np.uint8)

    photo_edges = _photo_edges(sharp_rgb)

    smoothed = pil.filter(ImageFilter.MedianFilter(size=MEDIAN_SIZE))
    smoothed = smoothed.filter(ImageFilter.GaussianBlur(radius=SMOOTH_RADIUS))
    smooth_rgb = np.asarray(smoothed, dtype=np.uint8)

    labels, palette = _posterize(smooth_rgb, n_colors)
    labels = _clean_regions(labels, int(MIN_REGION_AREA_RATIO * labels.size))

    used_color_ids = sorted(int(c) for c in np.unique(labels))
    color_id_to_number = {cid: idx + 1 for idx, cid in enumerate(used_color_ids)}

    preview_img = Image.fromarray(palette[labels].astype(np.uint8), mode="RGB")
    page_img = _render_page(labels, color_id_to_number, photo_edges)

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


def _photo_edges(rgb: np.ndarray) -> np.ndarray:
    """Detect detail edges directly on the sharp photo so faces/doors/etc survive."""
    gray = (0.299 * rgb[..., 0] + 0.587 * rgb[..., 1] + 0.114 * rgb[..., 2]).astype(np.float32)
    smoothed = ndimage.gaussian_filter(gray, sigma=1.2)
    sx = ndimage.sobel(smoothed, axis=1)
    sy = ndimage.sobel(smoothed, axis=0)
    magnitude = np.hypot(sx, sy)
    edges = magnitude > PHOTO_EDGE_THRESHOLD
    edges = ndimage.binary_closing(edges, iterations=1)
    edges = _remove_small(edges, min_size=12)
    return edges


def _remove_small(mask: np.ndarray, min_size: int) -> np.ndarray:
    labelled, n = ndimage.label(mask)
    if n == 0:
        return mask
    sizes = ndimage.sum(mask, labelled, index=range(1, n + 1))
    keep = np.zeros(n + 1, dtype=bool)
    keep[1:] = sizes >= min_size
    return keep[labelled]


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

    while changed and iterations < 5:
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


def _render_page(labels: np.ndarray, color_id_to_number: dict, photo_edges: np.ndarray) -> Image.Image:
    h, w = labels.shape
    region_edges = _edge_mask(labels)
    combined_edges = region_edges | photo_edges

    canvas = np.empty((h, w, 3), dtype=np.uint8)
    canvas[..., :] = PAGE_BG
    canvas[combined_edges] = OUTLINE_RGB
    page = Image.fromarray(canvas, mode="RGB")
    draw = ImageDraw.Draw(page)

    min_number_area = MIN_NUMBER_AREA_RATIO * labels.size

    for color_id in np.unique(labels):
        mask = labels == color_id
        comp, n_comp = ndimage.label(mask)
        if n_comp == 0:
            continue
        sizes = ndimage.sum(mask, comp, index=range(1, n_comp + 1))
        number = color_id_to_number[int(color_id)]

        for region_idx, area in enumerate(sizes, start=1):
            if area < min_number_area:
                continue
            region_mask = comp == region_idx
            cy, cx = _pole_of_inaccessibility(region_mask)
            font = _font_for_area(area)
            text = str(number)
            bbox = draw.textbbox((0, 0), text, font=font)
            tw = bbox[2] - bbox[0]
            th = bbox[3] - bbox[1]
            _draw_text_with_halo(draw, (cx - tw / 2, cy - th / 2), text, font)

    return page


def _pole_of_inaccessibility(region_mask: np.ndarray) -> Tuple[float, float]:
    """Point inside the region that is farthest from any border — always inside."""
    distance = ndimage.distance_transform_edt(region_mask)
    cy, cx = np.unravel_index(int(distance.argmax()), distance.shape)
    return float(cy), float(cx)


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
    return edges


def _font_for_area(area: float) -> ImageFont.ImageFont:
    radius = float(np.sqrt(area / np.pi))
    size = int(max(11, min(40, radius * 0.45)))
    for candidate in ("arial.ttf", "DejaVuSans.ttf", "Helvetica.ttc"):
        try:
            return ImageFont.truetype(candidate, size=size)
        except OSError:
            continue
    return ImageFont.load_default()


def _draw_text_with_halo(draw: ImageDraw.ImageDraw, xy, text: str, font) -> None:
    """White halo around the number so it stays readable on top of dark photo edges."""
    x, y = xy
    for dx, dy in ((-1, 0), (1, 0), (0, -1), (0, 1), (-1, -1), (1, 1), (-1, 1), (1, -1)):
        draw.text((x + dx, y + dy), text, fill=PAGE_BG, font=font)
    draw.text((x, y), text, fill=OUTLINE_RGB, font=font)


def _encode_png(img: Image.Image) -> str:
    buffer = io.BytesIO()
    img.save(buffer, format="PNG", optimize=True)
    return base64.b64encode(buffer.getvalue()).decode("utf-8")

"""Turn a photo into a paint-by-number coloring page that stays close to the original."""

from __future__ import annotations

import base64
import io
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from functools import lru_cache
from typing import List, Tuple

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont
from scipy import ndimage
from sklearn.cluster import KMeans



PAGE_SIZE = 1400
KMEANS_FIT_SIZE = 160
SMOOTH_RADIUS = 1.4
PHOTO_EDGE_THRESHOLD = 70
MIN_REGION_AREA_RATIO = 0.0008
MIN_NUMBER_AREA_RATIO = 0.0005
CLEAN_MAX_PASSES = 5
OUTLINE_GRAY = 15
PNG_COMPRESS_LEVEL = 6  # zlib default: ~10% larger than optimize=True at a tenth of the time

_POOL = ThreadPoolExecutor(max_workers=4, thread_name_prefix="coloring")


@dataclass
class ColoringResult:
    page_png_b64: str
    preview_png_b64: str
    legend: List[dict]
    n_colors_used: int
    outline_png_b64: str
    numbers_png_b64: str


def clamp_colors(n_colors: int) -> int:
    return max(4, min(16, int(n_colors)))


def build_coloring_page(image_bytes: bytes, n_colors: int = 10) -> ColoringResult:
    n_colors = clamp_colors(n_colors)

    pil = Image.open(io.BytesIO(image_bytes))
    pil.draft("RGB", (PAGE_SIZE, PAGE_SIZE))  # lets JPEG decode at a reduced scale when it's huge
    pil = _fit_square(pil.convert("RGB"), PAGE_SIZE)
    sharp_rgb = np.asarray(pil, dtype=np.uint8)

    # Photo edges only need the sharp photo, so they run next to smoothing + posterizing.
    edges_job = _POOL.submit(_photo_edges, sharp_rgb)

    smooth_rgb = _median3(sharp_rgb)
    smoothed = Image.fromarray(smooth_rgb).filter(ImageFilter.GaussianBlur(radius=SMOOTH_RADIUS))
    smooth_rgb = np.asarray(smoothed, dtype=np.uint8)

    labels, palette = _posterize(smooth_rgb, n_colors)
    labels, comp, area = _clean_regions(labels, int(MIN_REGION_AREA_RATIO * labels.size), n_colors)

    used_color_ids = sorted(int(c) for c in np.unique(labels))
    color_id_to_number = {cid: idx + 1 for idx, cid in enumerate(used_color_ids)}

    palette_u8 = palette.astype(np.uint8)
    preview_job = _POOL.submit(_encode_preview, labels, palette_u8)
    outline_img, page_img, numbers_img = _render_page(
        labels, comp, area, color_id_to_number, edges_job.result()
    )

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
        preview_png_b64=preview_job.result(),
        legend=legend,
        n_colors_used=len(used_color_ids),
        outline_png_b64=_encode_png(outline_img),
        numbers_png_b64=_encode_png(numbers_img),
    )


def _fit_square(img: Image.Image, size: int) -> Image.Image:
    src = img.copy()
    src.thumbnail((size, size), Image.LANCZOS)
    return src


def _median3(rgb: np.ndarray) -> np.ndarray:
    """3x3 median per channel (sorting network on shifted views); border pixels stay as-is."""
    h, w, _ = rgb.shape
    if h < 3 or w < 3:
        return rgb
    p = [np.ascontiguousarray(rgb[dy:h - 2 + dy, dx:w - 2 + dx]) for dy in range(3) for dx in range(3)]
    for a, b in ((1, 2), (4, 5), (7, 8), (0, 1), (3, 4), (6, 7), (1, 2), (4, 5), (7, 8),
                 (0, 3), (5, 8), (4, 7), (3, 6), (1, 4), (2, 5), (4, 7), (4, 2), (6, 4), (4, 2)):
        lo = np.minimum(p[a], p[b])
        np.maximum(p[a], p[b], out=p[b])
        p[a] = lo
    out = rgb.copy()
    out[1:-1, 1:-1] = p[4]
    return out


def _photo_edges(rgb: np.ndarray) -> np.ndarray:
    """Detect detail edges directly on the sharp photo so faces/doors/etc survive."""
    gray = (0.299 * rgb[..., 0] + 0.587 * rgb[..., 1] + 0.114 * rgb[..., 2]).astype(np.float32)
    smoothed = ndimage.gaussian_filter(gray, sigma=1.2)
    sx = ndimage.sobel(smoothed, axis=1)
    sy = ndimage.sobel(smoothed, axis=0)
    edges = (sx * sx + sy * sy) > PHOTO_EDGE_THRESHOLD ** 2
    edges = ndimage.binary_closing(edges, iterations=1)
    edges = _remove_small(edges, min_size=12)
    return edges


def _remove_small(mask: np.ndarray, min_size: int) -> np.ndarray:
    labelled, n = ndimage.label(mask)
    if n == 0:
        return mask
    keep = np.bincount(labelled.ravel(), minlength=n + 1) >= min_size
    keep[0] = False
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


def _label_regions(labels: np.ndarray, n_colors: int) -> Tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Connected regions across all colours: (region id per pixel, colour per id, area per id).

    Ids start at 1; id 0 is unused so the arrays can be indexed directly by region id.
    """
    found = list(_POOL.map(lambda cid: ndimage.label(labels == cid), range(n_colors)))
    counts = [n for _, n in found]
    offsets = np.cumsum([0] + counts)
    comp = np.zeros(labels.shape, dtype=np.int32)

    def place(args):  # colours cover disjoint pixels, so these writes can run side by side
        (lab, n), offset = args
        if n:
            np.add(lab, offset, out=comp, where=lab > 0)

    list(_POOL.map(place, zip(found, offsets)))
    colour_of = np.repeat(np.arange(-1, n_colors), [1] + counts).astype(np.int32)
    return comp, colour_of, np.bincount(comp.ravel(), minlength=int(offsets[-1]) + 1)


def _clean_regions(labels: np.ndarray, min_area: int, n_colors: int):
    """Merge every region below min_area into the colour that borders it the most.

    Returns (labels, region id per pixel, area per region id).
    """
    cleaned = labels
    for pass_no in range(CLEAN_MAX_PASSES + 1):
        comp, colour_of, area = _label_regions(cleaned, n_colors)
        small = area < min_area
        small[0] = False
        if pass_no == CLEAN_MAX_PASSES or not small.any():
            break
        target = _merge_targets(comp, colour_of, small, n_colors)
        if (target == np.arange(len(area))).all():
            break
        cleaned = colour_of[target][comp]
    return cleaned, comp, area


def _merge_targets(comp, colour_of, small, n_colors) -> np.ndarray:
    """For each region the region it should merge into (itself if it stays as it is)."""
    n_regions = len(colour_of)
    src_parts, dst_parts = [], []
    for a, b in ((comp[:, :-1], comp[:, 1:]), (comp[:-1, :], comp[1:, :])):
        diff = a != b
        ra, rb = a[diff], b[diff]
        src_parts += [ra, rb]
        dst_parts += [rb, ra]
    src, dst = np.concatenate(src_parts), np.concatenate(dst_parts)
    keep = small[src]
    # Shared border length for every (small region, neighbouring region) pair.
    pair, border = np.unique(src[keep].astype(np.int64) * n_regions + dst[keep], return_counts=True)
    src, dst = pair // n_regions, pair % n_regions
    # A small region may only join a small neighbour with a higher id, so chains can't loop.
    allowed = ~small[dst] | (dst > src)
    src, dst, border = src[allowed], dst[allowed], border[allowed]

    # The small region joins the colour that touches it the most ...
    votes = np.bincount(src * n_colors + colour_of[dst], weights=border, minlength=n_regions * n_colors)
    best_colour = votes.reshape(n_regions, n_colors).argmax(axis=1)
    # ... through its longest border with a region of that colour.
    on_best = colour_of[dst] == best_colour[src]
    src, dst, border = src[on_best], dst[on_best], border[on_best]
    order = np.lexsort((dst, border, src))  # last row of each src group = longest border
    last = np.r_[src[order][1:] != src[order][:-1], True]

    target = np.arange(n_regions)
    target[src[order][last]] = dst[order][last]
    while True:  # follow chains of small regions down to the region they finally merge into
        hop = target[target]
        if (hop == target).all():
            return target
        target = hop


def _render_page(labels, comp, area, color_id_to_number, photo_edges):
    """Return (outline-only image, outlines + numbers image, numbers-only RGBA layer)."""
    h, w = labels.shape
    region_edges = _edge_mask(labels)
    combined_edges = region_edges | photo_edges

    outline = np.where(combined_edges, OUTLINE_GRAY, 255).astype(np.uint8)
    outline_img = Image.fromarray(combined_edges.astype(np.uint8), mode="P")  # 1-bit indexed
    outline_img.putpalette([255, 255, 255, OUTLINE_GRAY, OUTLINE_GRAY, OUTLINE_GRAY])
    page = Image.fromarray(outline.copy(), mode="L")
    draw = ImageDraw.Draw(page)

    min_number_area = MIN_NUMBER_AREA_RATIO * labels.size
    # Poles of inaccessibility from one distance map for the whole page (distance to the
    # nearest region border), computed at half size: a few pixels of slack don't matter here.
    hh, ww = h // 2, w // 2
    edges2 = (region_edges[0:2 * hh:2, 0:2 * ww:2] | region_edges[1:2 * hh:2, 0:2 * ww:2]
              | region_edges[0:2 * hh:2, 1:2 * ww:2] | region_edges[1:2 * hh:2, 1:2 * ww:2])
    distance = ndimage.distance_transform_edt(~edges2)
    comp2 = comp[0:2 * hh:2, 0:2 * ww:2]
    labels2 = labels[0:2 * hh:2, 0:2 * ww:2]
    boxes = ndimage.find_objects(comp2)

    for region_id in np.flatnonzero(area >= min_number_area):
        if region_id == 0 or region_id > len(boxes) or boxes[region_id - 1] is None:
            continue
        box = boxes[region_id - 1]
        inside = comp2[box] == region_id
        cy, cx = np.unravel_index(int(np.where(inside, distance[box], -1.0).argmax()), inside.shape)
        cy += box[0].start
        cx += box[1].start
        text = str(color_id_to_number[int(labels2[cy, cx])])
        font = _font_for_area(int(area[region_id]))
        tw, th = _text_size(text, font)
        cy, cx = 2 * cy + 1, 2 * cx + 1

        # Keep numbers inside the image bounds
        margin = 4
        clamped_cx = max(tw / 2 + margin, min(w - tw / 2 - margin, cx))
        clamped_cy = max(th / 2 + margin, min(h - th / 2 - margin, cy))

        _draw_text_with_halo(draw, (clamped_cx - tw / 2, clamped_cy - th / 2), text, font)

    return outline_img, page, _numbers_layer(outline, np.asarray(page))


def _numbers_layer(outline: np.ndarray, page: np.ndarray) -> Image.Image:
    """RGBA layer holding only the numbers; alpha-compositing it over the outline gives the page.

    The page is grey only, and an outline pixel is either white or the outline grey, so each
    pixel the numbers touched is rebuilt as black or white ink at the alpha that lands on it.
    """
    layer = np.zeros(outline.shape + (4,), dtype=np.uint8)
    touched = page != outline
    base = outline[touched].astype(np.int16)
    value = page[touched].astype(np.int16)
    ink = np.where(value > base, 255, OUTLINE_GRAY).astype(np.uint8)
    alpha = np.rint(np.abs(value - base) * 255.0 / (255 - OUTLINE_GRAY)).astype(np.uint8)
    layer[touched] = np.stack([ink, ink, ink, alpha], axis=1)
    return Image.fromarray(layer, mode="RGBA")


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
    return _font(int(max(11, min(40, radius * 0.45))))


@lru_cache(maxsize=None)
def _font(size: int) -> ImageFont.ImageFont:
    for candidate in ("arial.ttf", "DejaVuSans.ttf", "Helvetica.ttc"):
        try:
            return ImageFont.truetype(candidate, size=size)
        except OSError:
            continue
    return ImageFont.load_default()


@lru_cache(maxsize=None)
def _text_size(text: str, font) -> Tuple[int, int]:
    left, top, right, bottom = font.getbbox(text)
    return right - left, bottom - top


def _draw_text_with_halo(draw: ImageDraw.ImageDraw, xy, text: str, font) -> None:
    """White halo around the number so it stays readable on top of dark photo edges."""
    x, y = xy
    for dx, dy in ((-1, 0), (1, 0), (0, -1), (0, 1), (-1, -1), (1, 1), (-1, 1), (1, -1)):
        draw.text((x + dx, y + dy), text, fill=255, font=font)
    draw.text((x, y), text, fill=OUTLINE_GRAY, font=font)


def _encode_preview(labels: np.ndarray, palette: np.ndarray) -> str:
    """Painted answer key as an indexed PNG (at most 16 colours, so it's small and quick)."""
    img = Image.fromarray(labels.astype(np.uint8), mode="P")
    img.putpalette(palette.astype(np.uint8).ravel().tolist())
    return _encode_png(img)


def _encode_png(img: Image.Image) -> str:
    buffer = io.BytesIO()
    img.save(buffer, format="PNG", compress_level=PNG_COMPRESS_LEVEL)
    return base64.b64encode(buffer.getvalue()).decode("utf-8")

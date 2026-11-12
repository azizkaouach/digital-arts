// viewer3d.js - "Showcase": turns the child's painting into a free-standing 3D layered paper sculpture
// that can be turned a full 360 degrees. Each legend colour becomes a solid slab of card (traced to
// real geometry), stacked big -> small, and the painted regions come alive (ripples, swaying plants, glow, haze).
// Usage: openShowcase({ paintCanvas, outlineImage, legend, title })
import * as THREE from "/vendor/three.module.js";
import { OrbitControls } from "/vendor/OrbitControls.js";

const SRC_MAX = 1280;      // the painting is read at most this big (nearest sampling: no blended colours)
const TRACE = 480;         // longest side of the grid the colour regions are traced on
const INK_MAX = 1536;      // longest side of the outline texture
const CARD_LONG = 4.0;     // world size of the card's longest side
const BOARD_T = 0.14;      // thickness of the white backing board
const SLAB_MAX = 0.06;     // thickness of one card layer (shrinks when there are many layers)
const DEPTH_MAX = 0.8;     // total thickness of all layers
const PLINTH_H = 0.12;     // height of the little stand the card is slotted into
const MIN_ISLAND = 10;     // contours enclosing fewer trace pixels than this are dropped
const MAX_POINTS = 70000;  // contour point budget over all layers (about 3 triangles per point)
const MIN_LAYER_AREA = 0.0004; // colours covering less than this share of the page are merged into the base
const IDLE_SPIN_MS = 4000; // auto-rotate starts after this much idle time
const TAU = Math.PI * 2;

let current = null;        // only one showcase can be open at a time

function ensureCss() {
  if (document.querySelector("link[data-v3d]")) return;
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = "/viewer3d.css";
  link.dataset.v3d = "1";
  document.head.appendChild(link);
}

// ---------------------------------------------------------------------------
// Colour classification: legend colour -> animation "kind" weights
// ---------------------------------------------------------------------------
const clamp01 = (x) => Math.min(1, Math.max(0, x));
// GLSL-style smoothstep, also works when e0 > e1 (reversed ramp)
function sstep(e0, e1, x) {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
}

function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2, d = mx - mn;
  if (d < 1e-6) return [0, 0, l];
  const s = d / (1 - Math.abs(2 * l - 1));
  let h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [(h * 60 + 360) % 360, s, l];
}

// Returns soft weights {water, plant, warm, cloud, dark} that sum to 1.
function classifyColor(r, g, b) {
  const [h, s, l] = rgbToHsl(r, g, b);
  const lowSat = sstep(0.30, 0.12, s);
  const cloud = Math.max(sstep(0.78, 0.90, l), lowSat * sstep(0.42, 0.60, l));
  const brown = (h >= 5 && h <= 50 ? 1 : 0) * sstep(0.45, 0.30, l) * sstep(0.70, 0.50, s);
  const dark = Math.max(sstep(0.30, 0.16, l), lowSat * (1 - sstep(0.42, 0.60, l)), brown) * (1 - cloud);
  const chroma = Math.max(0, 1 - cloud - dark);
  const plant = sstep(55, 80, h) * (1 - sstep(150, 175, h));
  const water = sstep(150, 175, h) * (1 - sstep(245, 270, h));
  const warm = Math.max(0, 1 - plant - water);
  const w = { water: water * chroma, plant: plant * chroma, warm: warm * chroma, cloud, dark };
  const sum = w.water + w.plant + w.warm + w.cloud + w.dark || 1;
  for (const k in w) w[k] /= sum;
  return w;
}

// ---------------------------------------------------------------------------
// Pixel work: paint canvas -> soft coverage field per legend colour, cumulated back -> front
// ---------------------------------------------------------------------------
function readPixels(source, w, h, smooth = true) {
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  ctx.imageSmoothingEnabled = smooth;
  if (smooth) ctx.imageSmoothingQuality = "high";
  ctx.drawImage(source, 0, 0, w, h);
  return ctx.getImageData(0, 0, w, h).data;
}

function boxBlur(src, w, h, r) {
  const tmp = new Float32Array(w * h), out = new Float32Array(w * h), inv = 1 / (2 * r + 1);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let k = -r; k <= r; k++) s += src[y * w + Math.min(w - 1, Math.max(0, x + k))];
      tmp[y * w + x] = s * inv;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let k = -r; k <= r; k++) s += tmp[Math.min(h - 1, Math.max(0, y + k)) * w + x];
      out[y * w + x] = s * inv;
    }
  }
  return out;
}

function cardSize(aspect) {
  return aspect >= 1 ? [CARD_LONG, CARD_LONG / aspect] : [CARD_LONG * aspect, CARD_LONG];
}

// Classifies every painted pixel to its nearest legend colour and accumulates, per colour, the share of
// each trace cell it covers (so region edges are antialiased without ever blending two palette colours).
// Returns colours sorted big -> small (= back -> front) with a coverage field each; tiny colours are
// merged into the base layer.
function buildCoverage(paintCanvas, legend) {
  const k0 = Math.min(1, SRC_MAX / Math.max(paintCanvas.width, paintCanvas.height));
  const sw = Math.max(2, Math.round(paintCanvas.width * k0)), sh = Math.max(2, Math.round(paintCanvas.height * k0));
  const px = readPixels(paintCanvas, sw, sh, false);
  const kt = TRACE / Math.max(sw, sh);
  const tw = Math.max(2, Math.round(sw * kt)), th = Math.max(2, Math.round(sh * kt));
  const n = legend.length;
  const pal = legend.map((e) => e.rgb || [parseInt(e.hex.slice(1, 3), 16), parseInt(e.hex.slice(3, 5), 16), parseInt(e.hex.slice(5, 7), 16)]);
  const cov = Array.from({ length: n }, () => new Float32Array(tw * th));
  const cnt = new Float32Array(tw * th), area = new Float64Array(n);
  const colOf = new Int32Array(sw), cache = new Map();
  for (let x = 0; x < sw; x++) colOf[x] = Math.min(tw - 1, Math.floor((x * tw) / sw));
  let painted = 0;
  for (let y = 0, i = 0; y < sh; y++) {
    const rowBase = Math.min(th - 1, Math.floor((y * th) / sh)) * tw;
    for (let x = 0; x < sw; x++, i++) {
      const cell = rowBase + colOf[x];
      cnt[cell]++;
      if (px[i * 4 + 3] < 40) continue;
      const key = (px[i * 4] << 16) | (px[i * 4 + 1] << 8) | px[i * 4 + 2];
      let k = cache.get(key);
      if (k === undefined) {                       // flood fills repeat the same colour: search once
        let best = Infinity; k = 0;
        for (let j = 0; j < n; j++) {
          const dr = px[i * 4] - pal[j][0], dg = px[i * 4 + 1] - pal[j][1], db = px[i * 4 + 2] - pal[j][2];
          const d = dr * dr + dg * dg + db * db;
          if (d < best) { best = d; k = j; }
        }
        cache.set(key, k);
      }
      cov[k][cell]++; area[k]++; painted++;
    }
  }
  for (let k = 0; k < n; k++) { const c = cov[k]; for (let i = 0; i < c.length; i++) c[i] /= cnt[i]; }

  const total = sw * sh;
  const order = [...Array(n).keys()].filter((k) => area[k] > 0).sort((a, b) => area[b] - area[a]);
  if (!order.length) {                             // nothing painted at all: show a blank cream card (the hint explains)
    return { tw, th, coverage: 0, layers: [{ rgb: [243, 237, 224], weights: classifyColor(243, 237, 224), cov: new Float32Array(tw * th).fill(1) }] };
  }
  const kept = order.filter((k, i) => i === 0 || area[k] / total >= MIN_LAYER_AREA);
  for (const k of order) {                         // merge tiny colours into the base so nothing turns into a hole
    if (kept.includes(k)) continue;
    const base = cov[kept[0]], c = cov[k];
    for (let i = 0; i < base.length; i++) base[i] += c[i];
  }
  return {
    tw, th, coverage: painted / total,
    layers: kept.map((k) => ({ rgb: pal[k], weights: classifyColor(...pal[k]), cov: cov[k] })),
  };
}

// Outline image -> ink coverage (0..255). The integrator passes numbers-free outlines, so this is
// just a luminance -> alpha conversion that boosts thin antialiased lines.
function buildInk(img, w, h) {
  const px = readPixels(img, w, h), ink = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const lum = (px[i * 4] * 0.3 + px[i * 4 + 1] * 0.59 + px[i * 4 + 2] * 0.11) * (px[i * 4 + 3] / 255) + 255 - px[i * 4 + 3];
    ink[i] = Math.round(255 * clamp01(((255 - lum) / 255 - 0.05) / 0.55));
  }
  return ink;
}

// ---------------------------------------------------------------------------
// Contour tracing: coverage field -> closed rings (marching squares), simplified
// ---------------------------------------------------------------------------
// Cell case -> oriented segments between the cell's edges (0 top, 1 right, 2 bottom, 3 left).
// Orientation keeps "inside" on the left, so outer rings come out counter-clockwise and holes clockwise.
// Corner bits: top-left 1, top-right 2, bottom-right 4, bottom-left 8.
const MS_TABLE = [
  [], [[3, 0]], [[0, 1]], [[3, 1]], [[1, 2]], null, [[0, 2]], [[3, 2]],
  [[2, 3]], [[2, 0]], null, [[2, 1]], [[1, 3]], [[1, 0]], [[0, 3]], [],
];

// Returns rings in world units (x right, y up, centred on the card). Rings are clamped to the card
// rectangle so every slab ends flush with the backing board.
function traceRings(field, tw, th, cardW, cardH) {
  const T = 0.5, pw = tw + 4, ph = th + 4;      // padded: 1 replicated ring, then 1 empty ring
  const f = new Float32Array(pw * ph);
  for (let y = 1; y < ph - 1; y++) {
    const sy = Math.min(th - 1, Math.max(0, y - 2));
    for (let x = 1; x < pw - 1; x++) f[y * pw + x] = field[sy * tw + Math.min(tw - 1, Math.max(0, x - 2))];
  }
  const next = new Int32Array(pw * ph * 2).fill(-1);
  const hid = (x, y) => (y * pw + x) * 2, vid = (x, y) => (y * pw + x) * 2 + 1;   // edge ids
  for (let y = 0; y < ph - 1; y++) {
    for (let x = 0; x < pw - 1; x++) {
      const i = y * pw + x, a = f[i], b = f[i + 1], c = f[i + pw + 1], d = f[i + pw];
      const idx = (a >= T ? 1 : 0) | (b >= T ? 2 : 0) | (c >= T ? 4 : 0) | (d >= T ? 8 : 0);
      if (idx === 0 || idx === 15) continue;
      let segs = MS_TABLE[idx];
      if (!segs) {                              // saddle: decide by the cell centre
        const mid = (a + b + c + d) / 4 >= T;
        segs = idx === 5 ? (mid ? [[1, 0], [3, 2]] : [[3, 0], [1, 2]]) : (mid ? [[0, 3], [2, 1]] : [[0, 1], [2, 3]]);
      }
      const e = [hid(x, y), vid(x + 1, y), hid(x, y + 1), vid(x, y)];
      for (const [s, t] of segs) next[e[s]] = e[t];
    }
  }
  const sx = cardW / tw, sy = cardH / th, minArea = MIN_ISLAND * sx * sy;
  const point = (id, out, o) => {
    const e = id >> 1, ex = e % pw, ey = (e / pw) | 0;
    let px, py;
    if ((id & 1) === 0) { px = ex + (T - f[e]) / (f[e + 1] - f[e]) - 1.5; py = ey - 1.5; }
    else { px = ex - 1.5; py = ey + (T - f[e]) / (f[e + pw] - f[e]) - 1.5; }
    out[o] = Math.min(tw, Math.max(0, px)) * sx - cardW / 2;
    out[o + 1] = cardH / 2 - Math.min(th, Math.max(0, py)) * sy;
  };
  const seen = new Uint8Array(next.length), rings = [], buf = [];
  for (let s = 0; s < next.length; s++) {
    if (next[s] < 0 || seen[s]) continue;
    buf.length = 0;
    let cur = s;
    while (cur >= 0 && !seen[cur]) { seen[cur] = 1; buf.push(cur); cur = next[cur]; }
    if (cur !== s || buf.length < 4) continue;
    const pts = new Float32Array(buf.length * 2);
    for (let i = 0; i < buf.length; i++) point(buf[i], pts, i * 2);
    const area = ringArea(pts);
    if (Math.abs(area) >= minArea) rings.push({ pts, area });
  }
  return rings;
}

function ringArea(p) {              // shoelace, positive = counter-clockwise (y up)
  let a = 0;
  for (let i = 0, n = p.length / 2; i < n; i++) {
    const j = (i + 1) % n;
    a += p[i * 2] * p[j * 2 + 1] - p[j * 2] * p[i * 2 + 1];
  }
  return a / 2;
}

// Douglas-Peucker on a closed ring (anchored at point 0 and the point farthest from it), duplicates removed.
function simplifyRing(r, eps) {
  let n = r.length / 2;
  const keepPts = [];
  for (let i = 0; i < n; i++) {                       // drop consecutive duplicates (clamping creates them)
    const l = keepPts.length;
    if (l && Math.abs(r[i * 2] - keepPts[l - 2]) < 1e-6 && Math.abs(r[i * 2 + 1] - keepPts[l - 1]) < 1e-6) continue;
    keepPts.push(r[i * 2], r[i * 2 + 1]);
  }
  while (keepPts.length > 2 && Math.abs(keepPts[0] - keepPts[keepPts.length - 2]) < 1e-6 && Math.abs(keepPts[1] - keepPts[keepPts.length - 1]) < 1e-6) keepPts.length -= 2;
  r = keepPts; n = r.length / 2;
  if (n <= 4) return Float32Array.from(r);
  let far = 0, best = -1;
  for (let i = 1; i < n; i++) {
    const d = (r[i * 2] - r[0]) ** 2 + (r[i * 2 + 1] - r[1]) ** 2;
    if (d > best) { best = d; far = i; }
  }
  const keep = new Uint8Array(n);
  keep[0] = keep[far] = 1;
  const stack = [[0, far], [far, n]], e2 = eps * eps;
  while (stack.length) {
    const [a, b] = stack.pop();
    if (b - a < 2) continue;
    const ax = r[a * 2], ay = r[a * 2 + 1], bi = b % n;
    const dx = r[bi * 2] - ax, dy = r[bi * 2 + 1] - ay, len2 = dx * dx + dy * dy;
    let md = -1, mi = -1;
    for (let i = a + 1; i < b; i++) {
      const px = r[i * 2] - ax, py = r[i * 2 + 1] - ay;
      const cr = px * dy - py * dx;
      const d2 = len2 < 1e-18 ? px * px + py * py : (cr * cr) / len2;
      if (d2 > md) { md = d2; mi = i; }
    }
    if (md > e2) { keep[mi] = 1; stack.push([a, mi], [mi, b]); }
  }
  const out = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(r[i * 2], r[i * 2 + 1]);
  return Float32Array.from(out);
}

// ---------------------------------------------------------------------------
// Geometry: rings -> solid slab (top cap + side walls, no hidden bottom)
// ---------------------------------------------------------------------------
function inRing(p, x, y) {          // even-odd point in polygon
  let inside = false;
  for (let i = 0, n = p.length / 2, j = n - 1; i < n; j = i++) {
    const xi = p[i * 2], yi = p[i * 2 + 1], xj = p[j * 2], yj = p[j * 2 + 1];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// Groups rings into islands: one counter-clockwise outer ring plus the clockwise holes inside it.
function groupRings(rings) {
  const items = rings.map((r) => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let i = 0; i < r.length; i += 2) {
      x0 = Math.min(x0, r[i]); x1 = Math.max(x1, r[i]); y0 = Math.min(y0, r[i + 1]); y1 = Math.max(y1, r[i + 1]);
    }
    return { pts: r, area: ringArea(r), x0, y0, x1, y1 };
  });
  const outers = items.filter((r) => r.area > 0).map((r) => ({ outer: r, holes: [] }));
  for (const h of items) {
    if (h.area >= 0) continue;
    const mid = (h.pts.length / 4) | 0, hx = h.pts[mid * 2], hy = h.pts[mid * 2 + 1];
    let best = null;
    for (const g of outers) {
      const o = g.outer;
      if (hx < o.x0 || hx > o.x1 || hy < o.y0 || hy > o.y1) continue;
      if ((!best || o.area < best.outer.area) && inRing(o.pts, hx, hy)) best = g;
    }
    if (best) best.holes.push(h);
  }
  return outers;
}

// Builds one slab's BufferGeometry. Local z runs 0 (bottom) .. thick (top face).
// Groups: 0 = top cap, 1 = side walls. aGrow = 0 at the base of an island -> 1 at its top (plants sway by it).
function buildSlab(rings, thick, cardH) {
  const groups = groupRings(rings);
  let P = 0;
  for (const g of groups) { P += g.outer.pts.length / 2; for (const h of g.holes) P += h.pts.length / 2; }
  const capIdx = [];
  const pos = new Float32Array((P + P * 4) * 3), nrm = new Float32Array(pos.length), grow = new Float32Array(P * 5);
  let vc = 0;                                   // vertices written
  for (const g of groups) {
    const o = g.outer, height = Math.max(1e-6, o.y1 - o.y0);
    const damp = Math.min(1, Math.max(0.3, (0.18 * cardH) / height));
    const growOf = (y) => { const f = clamp01((y - o.y0) / height); return f * f * damp; };
    const contour = [], holes = [], base = vc;
    const addCap = (pts, list) => {
      for (let i = 0; i < pts.length; i += 2) {
        list.push(new THREE.Vector2(pts[i], pts[i + 1]));
        pos.set([pts[i], pts[i + 1], thick], vc * 3); nrm.set([0, 0, 1], vc * 3);
        grow[vc++] = growOf(pts[i + 1]);
      }
    };
    addCap(o.pts, contour);
    for (const h of g.holes) { const l = []; addCap(h.pts, l); holes.push(l); }
    let faces;
    try { faces = THREE.ShapeUtils.triangulateShape(contour, holes); } catch (e) { faces = []; }
    for (const f of faces) {
      const a = base + f[0], b = base + f[1], c = base + f[2];
      const cross = (pos[b * 3] - pos[a * 3]) * (pos[c * 3 + 1] - pos[a * 3 + 1]) - (pos[b * 3 + 1] - pos[a * 3 + 1]) * (pos[c * 3] - pos[a * 3]);
      if (cross >= 0) capIdx.push(a, b, c); else capIdx.push(a, c, b);   // keep faces pointing +z
    }
  }
  const wallIdx = [];
  for (const g of groups) {
    const o = g.outer, height = Math.max(1e-6, o.y1 - o.y0);
    const damp = Math.min(1, Math.max(0.3, (0.18 * cardH) / height));
    for (const r of [o, ...g.holes]) {
      const p = r.pts, n = p.length / 2, sn = new Float32Array(n * 2);   // per-segment outward normals
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n, dx = p[j * 2] - p[i * 2], dy = p[j * 2 + 1] - p[i * 2 + 1], l = Math.hypot(dx, dy) || 1;
        sn[i * 2] = dy / l; sn[i * 2 + 1] = -dx / l;
      }
      // smooth the normal at a corner unless the turn is sharp (card edges stay crisp)
      const vn = (a, b) => {
        const ax = sn[a * 2], ay = sn[a * 2 + 1], bx = sn[b * 2], by = sn[b * 2 + 1];
        if (ax * bx + ay * by < 0.64) return [bx, by];
        const mx = ax + bx, my = ay + by, l = Math.hypot(mx, my) || 1;
        return [mx / l, my / l];
      };
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n, ni = vn((i + n - 1) % n, i), nj = vn(i, j);
        const v = vc;
        const quad = [[i, 0, ni], [j, 0, nj], [j, thick, nj], [i, thick, ni]];
        quad.forEach(([k, z, nn], q) => {
          pos.set([p[k * 2], p[k * 2 + 1], z], (v + q) * 3);
          nrm.set([nn[0], nn[1], 0], (v + q) * 3);
          const f = clamp01((p[k * 2 + 1] - o.y0) / height);
          grow[v + q] = f * f * damp;
        });
        vc += 4;
        wallIdx.push(v, v + 1, v + 2, v, v + 2, v + 3);
      }
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos.subarray(0, vc * 3), 3));
  geo.setAttribute("normal", new THREE.BufferAttribute(nrm.subarray(0, vc * 3), 3));
  geo.setAttribute("aGrow", new THREE.BufferAttribute(grow.subarray(0, vc), 1));
  geo.setIndex(new THREE.BufferAttribute(Uint32Array.from([...capIdx, ...wallIdx]), 1));
  geo.addGroup(0, capIdx.length, 0);
  geo.addGroup(capIdx.length, wallIdx.length, 1);
  geo.computeBoundingSphere();
  return { geo, tris: (capIdx.length + wallIdx.length) / 3 };
}

// Whole pipeline: paint -> list of slabs {rgb, weights, geo, ao}. Fields are accumulated front -> back
// so layer i covers everything painted with colours i and in front of it (like stacked contour card).
function buildSculpture(paintCanvas, legend, cardW, cardH) {
  const cvg = buildCoverage(paintCanvas, legend);
  const { tw, th } = cvg, m = cvg.layers.length;
  const acc = new Float32Array(tw * th);
  const perLayer = Array.from({ length: m }, () => ({}));
  for (let i = m - 1; i >= 0; i--) {
    const cov = cvg.layers[i].cov;
    for (let k = 0; k < acc.length; k++) acc[k] += cov[k];
    const field = boxBlur(acc, tw, th, 1);
    perLayer[i].rings = traceRings(field, tw, th, cardW, cardH);
    // contact-shadow texture for the layer behind: blurred outline of this layer's cumulative shape
    if (i > 0) {
      const soft = boxBlur(boxBlur(field, tw, th, 2), tw, th, 2), ao = new Uint8Array(tw * th);
      for (let k = 0; k < ao.length; k++) ao[k] = Math.min(255, Math.round(soft[k] * 255));
      perLayer[i - 1].ao = ao;
    }
  }
  // simplify; coarsen until the point budget is met
  let eps = 0.4 * (cardW / tw), simplified;
  for (let tries = 0; tries < 8; tries++, eps *= 1.5) {
    simplified = perLayer.map((l) => l.rings.map((r) => simplifyRing(r.pts, eps)).filter((r) => r.length >= 6));
    if (simplified.reduce((s, rs) => s + rs.reduce((q, r) => q + r.length / 2, 0), 0) <= MAX_POINTS) break;
  }
  const thick = Math.min(SLAB_MAX, DEPTH_MAX / m);
  let tris = 0;
  const slabs = cvg.layers.map((L, i) => {
    const s = buildSlab(simplified[i], thick, cardH);
    tris += s.tris;
    return { rgb: L.rgb, weights: L.weights, geo: s.geo, ao: perLayer[i].ao || null };
  });
  return { slabs, tw, th, thick, tris, coverage: cvg.coverage };
}

// ---------------------------------------------------------------------------
// Textures
// ---------------------------------------------------------------------------
function dataTexture(data, w, h, mips = false) {
  const t = new THREE.DataTexture(data, w, h, THREE.RedFormat, THREE.UnsignedByteType);
  t.minFilter = mips ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.generateMipmaps = mips;
  t.unpackAlignment = 1;       // rows are not 4-byte aligned
  t.needsUpdate = true;
  return t;
}

// Tileable paper grain: soft blotches + white noise + short fibres. Mean value ~0.5.
function makeGrainTexture() {
  const N = 256, data = new Float32Array(N * N);
  let seed = 12345;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  const octave = (cells, amp) => {                 // tileable bilinear value noise
    const g = Float32Array.from({ length: cells * cells }, rnd), step = N / cells;
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const fx = x / step, fy = y / step, ix = Math.floor(fx), iy = Math.floor(fy);
        const tx = fx - ix, ty = fy - iy, x2 = (ix + 1) % cells, y2 = (iy + 1) % cells;
        const a = g[iy * cells + ix] + (g[iy * cells + x2] - g[iy * cells + ix]) * tx;
        const b = g[y2 * cells + ix] + (g[y2 * cells + x2] - g[y2 * cells + ix]) * tx;
        data[y * N + x] += (a + (b - a) * ty - 0.5) * amp;
      }
    }
  };
  octave(6, 0.35); octave(24, 0.22);
  for (let i = 0; i < N * N; i++) data[i] += (rnd() - 0.5) * 0.22;
  for (let f = 0; f < 700; f++) {                  // paper fibres
    let x = rnd() * N, y = rnd() * N;
    const ang = rnd() * TAU, len = 5 + rnd() * 12, v = (rnd() - 0.5) * 0.28;
    for (let s = 0; s < len; s++) {
      data[(Math.floor(y) & 255) * N + (Math.floor(x) & 255)] += v;
      x += Math.cos(ang); y += Math.sin(ang);
    }
  }
  const bytes = new Uint8Array(N * N);
  for (let i = 0; i < bytes.length; i++) bytes[i] = Math.round(255 * clamp01(0.5 + data[i]));
  const t = new THREE.DataTexture(bytes, N, N, THREE.RedFormat, THREE.UnsignedByteType);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.minFilter = THREE.LinearMipmapLinearFilter; t.magFilter = THREE.LinearFilter;
  t.generateMipmaps = true; t.needsUpdate = true;
  return t;
}

// Kraft-card back of the sculpture with a stamped label (and the title, if there is one).
function makeBackTexture(cardW, cardH, title, legend) {
  const long = 1280, k = long / Math.max(cardW, cardH), W = Math.round(cardW * k), H = Math.round(cardH * k);
  const c = document.createElement("canvas");
  c.width = W; c.height = H;
  const g = c.getContext("2d");
  g.fillStyle = "#c8a070"; g.fillRect(0, 0, W, H);
  let seed = 777;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  for (let i = 0; i < 5200; i++) {                  // kraft fibres and flecks
    const x = rnd() * W, y = rnd() * H, a = rnd() * TAU, l = 3 + rnd() * 14;
    g.strokeStyle = rnd() < 0.5 ? "rgba(70,42,18,0.10)" : "rgba(240,215,170,0.12)";
    g.lineWidth = 1;
    g.beginPath(); g.moveTo(x, y); g.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l); g.stroke();
  }
  const vg = g.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.25, W / 2, H / 2, Math.max(W, H) * 0.75);
  vg.addColorStop(0, "rgba(0,0,0,0)"); vg.addColorStop(1, "rgba(60,32,10,0.28)");
  g.fillStyle = vg; g.fillRect(0, 0, W, H);
  g.textAlign = "center"; g.textBaseline = "middle";
  const ink = "rgba(58,34,18,0.88)", u = Math.min(W, H) / 100;
  if (title) {
    g.fillStyle = ink;
    let size = 7.5 * u;
    g.font = `italic 600 ${size}px Georgia, "Times New Roman", serif`;
    while (g.measureText(title).width > W * 0.78 && size > 2.5 * u) { size *= 0.92; g.font = `italic 600 ${size}px Georgia, serif`; }
    g.fillText(title, W / 2, H * 0.36);
    g.fillRect(W / 2 - 9 * u, H * 0.36 + size * 0.85, 18 * u, Math.max(1.5, u * 0.25));
  }
  // row of paint dots: the picture's own palette
  const cols = (legend || []).slice(0, 16), dot = 2.1 * u, gap = dot * 2.9, x0 = W / 2 - ((cols.length - 1) * gap) / 2;
  cols.forEach((e, i) => {
    g.fillStyle = e.hex || "#888"; g.strokeStyle = "rgba(58,34,18,0.55)"; g.lineWidth = Math.max(1, u * 0.25);
    g.beginPath(); g.arc(x0 + i * gap, H * 0.52, dot, 0, TAU); g.fill(); g.stroke();
  });
  // rubber-stamp label
  const lw = Math.min(W * 0.86, 70 * u), lh = 17 * u, lx = W / 2 - lw / 2, ly = H * 0.68;
  g.strokeStyle = ink; g.lineWidth = Math.max(2, u * 0.45);
  const box = (x, y, w, h, r) => { g.beginPath(); if (g.roundRect) g.roundRect(x, y, w, h, r); else g.rect(x, y, w, h); g.stroke(); };
  box(lx, ly, lw, lh, 1.6 * u);
  g.lineWidth = Math.max(1, u * 0.2);
  box(lx + 0.9 * u, ly + 0.9 * u, lw - 1.8 * u, lh - 1.8 * u, 1 * u);
  g.fillStyle = ink;
  g.font = `700 ${3.9 * u}px "Segoe UI", Arial, sans-serif`;
  g.fillText("Paint-by-Number Studio", W / 2, ly + lh * 0.37, lw - 4 * u);
  g.font = `500 ${2.7 * u}px "Segoe UI", Arial, sans-serif`;
  g.fillText("Cultural Days · HIDE 2026", W / 2, ly + lh * 0.7, lw - 4 * u);
  g.fillStyle = "#c8a070";                          // worn-ink speckle: kraft colour dabbed over the stamp
  for (let i = 0; i < 900; i++) { g.globalAlpha = 0.25 + rnd() * 0.5; g.fillRect(lx + rnd() * lw, ly + rnd() * lh, 1 + rnd() * 1.5, 1 + rnd() * 1.5); }
  g.globalAlpha = 1;
  const t = new THREE.CanvasTexture(c);
  t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter; t.anisotropy = 4;
  return t;
}

// Soft round blob (contact shadow / floor light), alpha only in the red channel for the shader.
function makeBlobTexture(inner, outer) {
  const c = document.createElement("canvas");
  c.width = c.height = 256;
  const g = c.getContext("2d"), grad = g.createRadialGradient(128, 128, 0, 128, 128, 128);
  grad.addColorStop(0, `rgba(255,255,255,${inner})`);
  grad.addColorStop(0.55, `rgba(255,255,255,${inner * 0.45})`);
  grad.addColorStop(1, `rgba(255,255,255,${outer})`);
  g.fillStyle = grad; g.fillRect(0, 0, 256, 256);
  return new THREE.CanvasTexture(c);
}

// ---------------------------------------------------------------------------
// Shaders. All colours are display (sRGB) values, no tone mapping.
// ---------------------------------------------------------------------------
const NOISE = /* glsl */ `
float hash(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
}`;

// Key light follows the camera (uKey = world direction towards the light), so every side is lit well.
const LIGHT = /* glsl */ `
uniform vec3 uKey;
vec3 lightIt(vec3 col, vec3 n) {
  float d = max(dot(n, uKey), 0.0);
  return col * (0.46 + 0.10 * (0.5 + 0.5 * n.y) + 0.46 * d);
}`;

// Vertex stage of a slab. The "alive" motion lives here: vertices of the cut-out edges are nudged by
// position-based waves, so caps and walls move together and the solid never tears.
const SLAB_VERT = /* glsl */ `
attribute float aGrow;
uniform vec4 uKind;       // water, plant, warm, cloud weights
uniform float uDark, uTime, uAlive, uAspect, uThick;
uniform vec2 uCard;
varying vec2 vP;          // un-displaced position on the card plane
varying vec3 vN, vW;
varying float vH;         // 0 at the bottom of a wall, 1 at the top
void main() {
  vec2 uv = vec2(0.5 + position.x / uCard.x, 0.5 - position.y / uCard.y);   // card uv, y down
  vec2 p = vec2(uv.x * uAspect, uv.y);          // image space where height = 1
  float t = uTime, k = uAlive, g = aGrow;
  vec2 off = vec2(0.0);
  if (uKind.x > 0.01) {                         // WATER: layered sine ripples
    float w = uKind.x * k;
    off.x += w * 0.0045 * sin(p.y * 38.0 + t * 1.3 + 2.0 * sin(p.x * 7.0 + t * 0.6));
    off.y += w * 0.0035 * sin(p.x * 31.0 - t * 1.1 + 2.0 * sin(p.y * 9.0 - t * 0.5));
  }
  if (uKind.y > 0.01) {                         // PLANT: sway grows toward the top of each shape
    float w = uKind.y * k;
    float sw = sin(t * 0.9 + p.x * 5.0 + p.y * 2.0) + 0.5 * sin(t * 1.7 + p.x * 11.0);
    off.x += w * 0.009 * g * sw;
    off.y += w * 0.003 * g * sin(t * 1.2 + p.x * 7.0);
  }
  if (uKind.w > 0.01) {                         // CLOUD: slow breathing drift
    float w = uKind.w * k;
    off += w * 0.0035 * vec2(sin(t * 0.55 + p.x * 3.1 + p.y * 2.0), cos(t * 0.45 + p.y * 3.7 - p.x));
  }
  off += uDark * k * 0.0008 * vec2(sin(t * 0.5 + p.y * 3.0), cos(t * 0.45 + p.x * 3.0));
  // pinned near the card border so the slabs always end flush with the backing board
  float pin = smoothstep(0.0, 0.06, min(min(uv.x, 1.0 - uv.x), min(uv.y, 1.0 - uv.y)));
  vec3 pos = position;
  pos.xy += vec2(off.x, -off.y) * uCard.y * pin;
  vP = position.xy; vN = normal; vH = position.z / uThick;
  vec4 w4 = modelMatrix * vec4(pos, 1.0);
  vW = w4.xyz;
  gl_Position = projectionMatrix * viewMatrix * w4;
}`;

// Top face of a slab: flat paper colour + living light effects + contact shadow + printed outline ink.
const CAP_FRAG = /* glsl */ `
uniform sampler2D uGrain, uInk, uAO;
uniform vec3 uColor;
uniform vec4 uKind;
uniform float uTime, uAlive, uAspect;
uniform vec2 uCard;
varying vec2 vP;
varying vec3 vN;
${NOISE}
${LIGHT}
void main() {
  vec2 uv = vec2(0.5 + vP.x / uCard.x, 0.5 - vP.y / uCard.y);
  vec2 p = vec2(uv.x * uAspect, uv.y);
  float t = uTime, k = uAlive, shimmer = 0.0, glow = 0.0, haze = 0.0;
  if (uKind.x > 0.01) {                         // WATER: glints
    float w = uKind.x * k;
    float s = sin(p.x * 64.0 + 3.0 * sin(p.y * 17.0 + t * 0.4) - t * 0.9)
            * sin(p.y * 47.0 + 2.0 * sin(p.x * 13.0 - t * 0.35) + t * 0.7);
    shimmer = w * smoothstep(0.55, 0.95, s);
  }
  if (uKind.z > 0.01) {                         // WARM: sun / fire glow, slow flicker (< 0.6 Hz)
    float w = uKind.z * k;
    float n = vnoise(p * 4.0 + vec2(0.0, -t * 0.15));
    glow = w * (0.65 * (0.5 + 0.5 * sin(t * 1.9 + n * 6.0)) + 0.35 * (0.5 + 0.5 * sin(t * 3.1 + n * 11.0 + 1.3)) - 0.5);
  }
  if (uKind.w > 0.01) {                         // CLOUD: drifting fbm haze
    float w = uKind.w * k;
    vec2 q = p * 2.4 + vec2(t * 0.025, t * 0.01);
    haze = w * (0.6 * vnoise(q) + 0.3 * vnoise(q * 2.1 + 7.0) + 0.1 * vnoise(q * 4.3) - 0.5);
  }
  float gr = mix(texture2D(uGrain, p * 3.0).r, texture2D(uGrain, p * 0.7 + 0.37).r, 0.35);
  vec3 col = uColor * (0.88 + 0.24 * gr);
  col = col * (1.0 + 0.30 * glow + 0.22 * haze) + vec3(0.20, 0.09, 0.0) * glow + vec3(0.06) * haze;
  col = mix(col, vec3(1.0, 0.98, 0.90), shimmer * 0.30);
  col *= 1.0 - 0.5 * smoothstep(0.03, 0.5, texture2D(uAO, uv).r);            // shadow at the foot of the next layer
  col = mix(col, vec3(0.11, 0.085, 0.075) * (0.8 + 0.4 * gr), texture2D(uInk, uv).r * 0.94);
  gl_FragColor = vec4(clamp(lightIt(col, vN), 0.0, 1.0), 1.0);
}`;

// Cut edge of a slab: lighter card core, a darker foot and a bright top rim.
const WALL_FRAG = /* glsl */ `
uniform sampler2D uGrain;
uniform vec3 uColor;
varying vec2 vP;
varying vec3 vN, vW;
varying float vH;
${LIGHT}
void main() {
  float gr = texture2D(uGrain, vec2(vW.x + vW.y, vW.z * 3.0) * 1.3).r;
  vec3 col = mix(uColor, vec3(1.0, 0.96, 0.90), 0.16) * (0.88 + 0.20 * gr);
  col *= 1.0 + 0.10 * smoothstep(0.78, 1.0, vH) - 0.20 * (1.0 - smoothstep(0.0, 0.18, vH));
  gl_FragColor = vec4(clamp(lightIt(col, vN), 0.0, 1.0), 1.0);
}`;

// Backing board: white card edges, kraft back with the stamped label (uMap).
const PAPER_VERT = /* glsl */ `
varying vec2 vUv;
varying vec3 vN, vW;
void main() {
  vUv = uv; vN = normal;
  vec4 w4 = modelMatrix * vec4(position, 1.0);
  vW = w4.xyz;
  gl_Position = projectionMatrix * viewMatrix * w4;
}`;
const PAPER_FRAG = /* glsl */ `
uniform sampler2D uGrain, uMap;
uniform vec3 uColor;
uniform float uUseMap;
varying vec2 vUv;
varying vec3 vN, vW;
${LIGHT}
void main() {
  float gr = texture2D(uGrain, vec2(vW.x + vW.z * 2.0, vW.y + vW.z) * 1.1).r;
  vec3 col = uUseMap > 0.5 ? texture2D(uMap, vUv).rgb : uColor * (0.90 + 0.20 * gr);
  gl_FragColor = vec4(clamp(lightIt(col, vN), 0.0, 1.0), 1.0);
}`;

// Floating golden dust: positions are computed from time in the vertex shader (no CPU per-frame work).
const DUST_VERT = /* glsl */ `
attribute vec4 aSeed;
uniform float uTime, uPx;
uniform vec4 uExt;     // half width, half height, front z, z range
varying float vA;
void main() {
  vec3 s = aSeed.xyz;
  float rise = fract(s.y + uTime * 0.012 * (0.5 + s.z));
  vec3 pos = vec3((s.x * 2.0 - 1.0) * uExt.x + sin(uTime * 0.15 + aSeed.w * 6.28) * 0.25,
                  (rise * 2.0 - 1.0) * uExt.y,
                  uExt.z - s.z * uExt.w);
  vA = smoothstep(0.0, 0.15, rise) * (1.0 - smoothstep(0.85, 1.0, rise)) * (0.55 + 0.45 * sin(uTime * 0.9 + aSeed.w * 40.0));
  vec4 mv = modelViewMatrix * vec4(pos, 1.0);
  gl_PointSize = 0.055 * uPx * (0.6 + s.z) / -mv.z;
  gl_Position = projectionMatrix * mv;
}`;
const DUST_FRAG = /* glsl */ `
varying float vA;
void main() {
  float d = length(gl_PointCoord - 0.5) * 2.0;
  float a = (1.0 - smoothstep(0.0, 1.0, d));
  gl_FragColor = vec4(1.0, 0.82, 0.48, a * a * vA * 0.85);
}`;

// ---------------------------------------------------------------------------
// Scene: turntable + plinth + backing board + stacked slabs + dust
// ---------------------------------------------------------------------------
function makeScene(built, ink, cardW, cardH, title, legend) {
  const aspect = cardW / cardH, { slabs, thick } = built;
  const depth = slabs.length * thick;
  const disposables = [];
  const track = (o) => { disposables.push(o); return o; };
  const shared = {
    uTime: { value: 0 }, uAlive: { value: 1 }, uKey: { value: new THREE.Vector3(-0.4, 0.6, 0.7).normalize() },
    uGrain: { value: track(makeGrainTexture()) }, uAspect: { value: aspect }, uCard: { value: new THREE.Vector2(cardW, cardH) },
  };
  const scene = new THREE.Scene();
  const hemi = new THREE.HemisphereLight(0xfff1e0, 0x6a4c38, 1.2);
  const sun = new THREE.DirectionalLight(0xffe2bd, 2.0);
  scene.add(hemi, sun);

  // -- turntable and plinth (lit by the standard lights; they follow the camera like the paper)
  const mid = (depth - BOARD_T) / 2;                       // z-centre of the sculpture's thickness
  const R = Math.max(1.7, Math.hypot(cardW / 2 + 0.1, (depth + BOARD_T) / 2 + 0.2) + 0.3);
  const std = (color, rough, extra = {}) => track(new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: 0.0, ...extra }));
  const platterGeo = track(new THREE.CylinderGeometry(R, R * 0.985, 0.2, 96).translate(0, -0.1, 0));
  scene.add(new THREE.Mesh(platterGeo, std(0xb89d78, 0.75)));
  const ringGeo = track(new THREE.RingGeometry(R - 0.2, R - 0.15, 96).rotateX(-Math.PI / 2).translate(0, 0.002, 0));
  scene.add(new THREE.Mesh(ringGeo, std(0xc9a055, 0.4, { metalness: 0.3 })));
  const plinthGeo = track(new THREE.BoxGeometry(cardW + 0.36, PLINTH_H, depth + BOARD_T + 0.3).translate(0, PLINTH_H / 2, 0));
  scene.add(new THREE.Mesh(plinthGeo, std(0x4a2f22, 0.55)));
  // soft contact shadow and a pool of warm floor light
  const blob = track(makeBlobTexture(1, 0)), blobTex2 = track(makeBlobTexture(1, 0));
  const floor = (tex, color, opacity, size, y) => {
    const g = track(new THREE.PlaneGeometry(size, size).rotateX(-Math.PI / 2));
    const m = track(new THREE.MeshBasicMaterial({ map: tex, color, opacity, transparent: true, depthWrite: false }));
    const mesh = new THREE.Mesh(g, m); mesh.position.y = y; mesh.renderOrder = -1;
    scene.add(mesh);
  };
  floor(blobTex2, 0xffc890, 0.16, R * 5.2, -0.205);
  floor(blob, 0x000000, 0.75, R * 2.7, -0.2);

  // -- the sculpture, standing on the plinth
  const obj = new THREE.Group();
  obj.position.set(0, PLINTH_H - 0.02 + cardH / 2, -mid);
  scene.add(obj);
  const inkTex = track(dataTexture(ink.data, ink.w, ink.h, true));
  inkTex.anisotropy = 4;
  const none = track(dataTexture(new Uint8Array([0]), 1, 1));
  const paper = (color, map) => track(new THREE.ShaderMaterial({
    vertexShader: PAPER_VERT, fragmentShader: PAPER_FRAG,
    uniforms: { uGrain: shared.uGrain, uKey: shared.uKey, uColor: { value: new THREE.Color(color) }, uMap: { value: map || null }, uUseMap: { value: map ? 1 : 0 } },
  }));
  const edge = paper(0xf4efe3), back = paper(0xb9915f, track(makeBackTexture(cardW, cardH, title, legend)));
  const boardGeo = track(new THREE.BoxGeometry(cardW, cardH, BOARD_T).translate(0, 0, -BOARD_T / 2));
  obj.add(new THREE.Mesh(boardGeo, [edge, edge, edge, edge, edge, back]));   // +x -x +y -y +z -z

  const meshes = slabs.map((S, i) => {
    const wt = S.weights, common = {
      uKind: { value: new THREE.Vector4(wt.water, wt.plant, wt.warm, wt.cloud) }, uDark: { value: wt.dark },
      uTime: shared.uTime, uAlive: shared.uAlive, uAspect: shared.uAspect, uCard: shared.uCard, uThick: { value: thick },
      uKey: shared.uKey, uGrain: shared.uGrain, uColor: { value: new THREE.Vector3(S.rgb[0] / 255, S.rgb[1] / 255, S.rgb[2] / 255) },
    };
    const capMat = track(new THREE.ShaderMaterial({
      vertexShader: SLAB_VERT, fragmentShader: CAP_FRAG,
      uniforms: { ...common, uInk: { value: inkTex }, uAO: { value: S.ao ? track(dataTexture(S.ao, built.tw, built.th)) : none } },
    }));
    const wallMat = track(new THREE.ShaderMaterial({ vertexShader: SLAB_VERT, fragmentShader: WALL_FRAG, uniforms: common }));
    track(S.geo);
    const mesh = new THREE.Mesh(S.geo, [capMat, wallMat]);
    mesh.frustumCulled = false;                    // the wobble is tiny but the bounds are cheap to skip
    mesh.position.z = i * 0.0015;
    obj.add(mesh);
    return mesh;
  });

  const dust = buildDust(obj, cardW, cardH, depth, track);
  return { scene, obj, meshes, thick, shared, dust, hemi, sun, cardW, cardH, depth, R, dispose: () => disposables.forEach((o) => o.dispose()) };
}

function buildDust(parent, cardW, cardH, depth, track) {
  const N = 48, seed = new Float32Array(N * 4);
  for (let i = 0; i < seed.length; i++) seed[i] = Math.random();
  const geo = track(new THREE.BufferGeometry());
  geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(N * 3), 3));
  geo.setAttribute("aSeed", new THREE.BufferAttribute(seed, 4));
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 100);   // positions are computed in the shader
  const material = track(new THREE.ShaderMaterial({
    vertexShader: DUST_VERT, fragmentShader: DUST_FRAG, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    uniforms: { uTime: { value: 0 }, uPx: { value: 600 }, uExt: { value: new THREE.Vector4(cardW / 2 + 0.5, cardH / 2, depth + 0.45, depth + 1.1) } },
  }));
  const pts = new THREE.Points(geo, material);
  pts.renderOrder = 999; pts.frustumCulled = false;
  parent.add(pts);
  return material;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}

export function openShowcase({ paintCanvas, outlineImage, legend, title } = {}) {
  if (current) current.close();
  document.querySelectorAll(".v3d-overlay").forEach((o) => o.remove());
  ensureCss();

  const prevFocus = document.activeElement;
  const overlay = el("div", "v3d-overlay");
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-label", "3D showcase");
  overlay.tabIndex = -1;
  if (title) overlay.appendChild(el("div", "v3d-title", title));
  const stage = el("div", "v3d-stage");
  overlay.appendChild(stage);
  const tip = el("div", "v3d-tip", "Drag to turn it around. Scroll or pinch to zoom.");
  stage.appendChild(tip);
  const hint = el("div", "v3d-hint", "Paint some regions first to see them pop out");
  hint.hidden = true;
  overlay.appendChild(hint);   // sits between the stage and the button bar
  const bar = el("div", "v3d-bar");
  const btnFront = el("button", "v3d-btn", "Front view");
  const btnSpin = el("button", "v3d-btn v3d-btn--accent", "Spin: on");
  const btnAlive = el("button", "v3d-btn v3d-btn--accent", "Alive: on");
  const btnSave = el("button", "v3d-btn", "Save picture");
  const btnClose = el("button", "v3d-btn", "Close");
  [btnFront, btnSpin, btnAlive, btnSave, btnClose].forEach((b) => { b.type = "button"; bar.appendChild(b); });
  overlay.appendChild(bar);
  document.body.appendChild(overlay);
  document.documentElement.classList.add("v3d-open");
  requestAnimationFrame(() => overlay.classList.add("is-in"));
  overlay.focus({ preventScroll: true });

  // -- state -----------------------------------------------------------------
  let renderer = null, sc = null, camera = null, controls = null, ro = null, raf = 0, closed = false;
  let alive = true, aliveLevel = 1, spinOn = true, resumeAt = performance.now() + IDLE_SPIN_MS + 1200, tween = null, stats = null;
  let fitDist = 10;
  const FOV = 30, FRONT_EL = 0.2;                // default camera elevation (radians)
  const target = new THREE.Vector3();
  const listeners = [];
  const listen = (t, type, fn, opts) => { t.addEventListener(type, fn, opts); listeners.push([t, type, fn, opts]); };

  function close() {
    if (closed) return;
    closed = true;
    if (current && current.overlay === overlay) current = null;
    cancelAnimationFrame(raf);
    if (ro) ro.disconnect();
    listeners.forEach(([t, ty, fn, o]) => t.removeEventListener(ty, fn, o));
    if (controls) controls.dispose();
    if (sc) sc.dispose();
    if (renderer) {
      renderer.dispose();
      renderer.forceContextLoss();
      renderer.domElement.remove();
    }
    document.documentElement.classList.remove("v3d-open");
    overlay.classList.remove("is-in");
    setTimeout(() => overlay.remove(), 400);        // let the backdrop fade out
    if (prevFocus && prevFocus.focus) { try { prevFocus.focus({ preventScroll: true }); } catch (e) { /* ignore */ } }
  }
  current = { close, overlay };
  listen(btnClose, "click", close);
  listen(window, "keydown", (e) => { if (e.key === "Escape") { e.preventDefault(); close(); } });
  listen(btnAlive, "click", () => {
    alive = !alive;
    btnAlive.textContent = alive ? "Alive: on" : "Alive: off";
    btnAlive.classList.toggle("v3d-btn--accent", alive);
    btnAlive.setAttribute("aria-pressed", String(alive));
  });
  listen(btnSpin, "click", () => {
    spinOn = !spinOn;
    resumeAt = performance.now();
    btnSpin.textContent = spinOn ? "Spin: on" : "Spin: off";
    btnSpin.classList.toggle("v3d-btn--accent", spinOn);
    btnSpin.setAttribute("aria-pressed", String(spinOn));
  });
  btnAlive.setAttribute("aria-pressed", "true");
  btnSpin.setAttribute("aria-pressed", "true");

  // -- build the 3D world ----------------------------------------------------
  try {
    const t0 = performance.now();
    const [cardW, cardH] = cardSize(paintCanvas.width / paintCanvas.height);
    const built = buildSculpture(paintCanvas, legend, cardW, cardH);
    let inkData = { data: new Uint8Array([0]), w: 1, h: 1 };
    try {                                           // a missing outline must not stop the sculpture
      const iw0 = outlineImage.naturalWidth || outlineImage.width, ih0 = outlineImage.naturalHeight || outlineImage.height;
      const k = Math.min(1, INK_MAX / Math.max(iw0, ih0)), iw = Math.max(1, Math.round(iw0 * k)), ih = Math.max(1, Math.round(ih0 * k));
      inkData = { data: buildInk(outlineImage, iw, ih), w: iw, h: ih };
    } catch (e) { console.warn("Showcase: outline unavailable", e); }
    if (built.coverage < 0.02) hint.hidden = false;
    stats = { buildMs: Math.round(performance.now() - t0), triangles: Math.round(built.tris), layers: built.slabs.length };
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "high-performance" });
    renderer.setClearColor(0x000000, 0);
    stage.appendChild(renderer.domElement);
    renderer.domElement.className = "v3d-canvas";
    renderer.domElement.setAttribute("aria-label", "Rotatable 3D paper sculpture of your painting");
    sc = makeScene(built, inkData, cardW, cardH, title, legend);
    camera = new THREE.PerspectiveCamera(FOV, 1, 0.1, 100);
    target.set(0, sc.obj.position.y - 0.12, 0);
    listen(renderer.domElement, "webglcontextlost", (e) => e.preventDefault());
    controls = new OrbitControls(camera, renderer.domElement);
    controls.target.copy(target);
    controls.enablePan = false;
    controls.enableDamping = true; controls.dampingFactor = 0.08;
    controls.rotateSpeed = 0.7; controls.zoomSpeed = 0.7;
    controls.minPolarAngle = Math.PI / 2 - 1.12;    // up to ~64 degrees above the horizon
    controls.maxPolarAngle = Math.PI / 2 + 0.38;    // ~22 degrees below it
    controls.autoRotateSpeed = 2.2;
    controls.addEventListener("start", () => { tween = null; resumeAt = Infinity; tip.classList.add("is-gone"); });
    controls.addEventListener("end", () => { resumeAt = performance.now() + IDLE_SPIN_MS; });
  } catch (err) {
    console.warn("Showcase could not start:", err);
    if (controls) { controls.dispose(); controls = null; }
    if (renderer) { renderer.domElement.remove(); renderer.dispose(); renderer = null; }
    if (sc) { sc.dispose(); sc = null; }
    hint.textContent = "The 3D view is not available on this device.";
    hint.hidden = false;
    tip.hidden = true;
    btnFront.disabled = btnSpin.disabled = btnAlive.disabled = btnSave.disabled = true;
    return { close };
  }

  // -- layout ----------------------------------------------------------------
  const sph = new THREE.Spherical();
  function resize() {
    const w = Math.max(1, stage.clientWidth), h = Math.max(1, stage.clientHeight);
    // cap devicePixelRatio at 2 and the total pixel count at ~2.6M so big projectors stay smooth
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2, Math.sqrt(2.6e6 / (w * h))));
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    // distance at which the card plus its turntable fill ~90% of the stage
    const tanH = Math.tan((FOV * Math.PI) / 360);
    const fh = sc.cardH + PLINTH_H + 0.9, fw = Math.max(sc.cardW + 0.9, sc.R * 2 * 0.98);
    const dist = Math.max(fh / 2 / tanH, fw / 2 / (tanH * camera.aspect)) / 0.92 + sc.depth / 2;
    const ratio = dist / fitDist;
    fitDist = dist;
    sph.setFromVector3(camera.position.clone().sub(target));
    if (Math.abs(ratio - 1) > 1e-4) {              // keep the same viewpoint, rescaled to the new framing
      sph.radius *= ratio;
      camera.position.setFromSpherical(sph).add(target);
    }
    controls.minDistance = dist * 0.55; controls.maxDistance = dist * 1.7;
    camera.near = dist * 0.1; camera.far = dist * 6; camera.updateProjectionMatrix();
    sc.dust.uniforms.uPx.value = (h * renderer.getPixelRatio()) / (2 * tanH);
  }
  camera.position.setFromSphericalCoords(fitDist, Math.PI / 2 - FRONT_EL, 0).add(target);   // front view, slightly from above
  resize();
  controls.update();
  // the stylesheet may still be loading on first open, so watch the stage instead of only window resizes
  if (window.ResizeObserver) { ro = new ResizeObserver(resize); ro.observe(stage); }
  else listen(window, "resize", resize);

  // -- camera moves ----------------------------------------------------------
  // Smoothly returns to the front view (shortest way round); also used with instant=true by tests.
  function setView(azimuthDeg, elevationDeg, instant, dist = fitDist) {
    const az = (azimuthDeg * Math.PI) / 180, el = (elevationDeg * Math.PI) / 180;
    if (instant) {
      camera.position.setFromSphericalCoords(dist, Math.PI / 2 - el, az).add(target);
      controls.update();
      return;
    }
    sph.setFromVector3(camera.position.clone().sub(target));
    let da = az - sph.theta;
    da = ((((da + Math.PI) % TAU) + TAU) % TAU) - Math.PI;
    tween = { t0: performance.now(), dur: 900, theta0: sph.theta, phi0: sph.phi, r0: sph.radius, dTheta: da, phi1: Math.PI / 2 - el, r1: dist };
  }
  listen(btnFront, "click", () => { setView(0, (FRONT_EL * 180) / Math.PI); resumeAt = performance.now() + IDLE_SPIN_MS; });

  // -- save picture ----------------------------------------------------------
  listen(btnSave, "click", () => {
    try {
      renderer.render(sc.scene, camera);          // render-then-read in the same task: no preserveDrawingBuffer needed
      const src = renderer.domElement, out = document.createElement("canvas");
      out.width = src.width; out.height = src.height;
      const ctx = out.getContext("2d");
      const bg = ctx.createRadialGradient(out.width / 2, out.height * 0.4, 0, out.width / 2, out.height * 0.4, Math.max(out.width, out.height) * 0.75);
      bg.addColorStop(0, "#3a2820"); bg.addColorStop(1, "#0e0807");
      ctx.fillStyle = bg; ctx.fillRect(0, 0, out.width, out.height);
      ctx.drawImage(src, 0, 0);
      const a = document.createElement("a");
      a.download = ((title || "showcase").replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, "-") || "showcase") + "-3d.png";
      a.href = out.toDataURL("image/png");
      document.body.appendChild(a); a.click(); a.remove();
    } catch (err) { console.warn("Save failed:", err); }
  });

  // -- animation loop --------------------------------------------------------
  const t0 = performance.now();
  let prev = t0;
  const easeOut = (x) => 1 - Math.pow(1 - clamp01(x), 3);
  const easeIO = (x) => { x = clamp01(x); return x * x * (3 - 2 * x); };
  const camRight = new THREE.Vector3(), camUp = new THREE.Vector3(), camBack = new THREE.Vector3();
  function frame(now) {
    if (closed) return;
    raf = requestAnimationFrame(frame);
    const t = (now - t0) / 1000, dt = Math.min(0.05, (now - prev) / 1000);
    prev = now;
    sc.shared.uTime.value = t;
    aliveLevel += ((alive ? 1 : 0) - aliveLevel) * (1 - Math.exp(-dt * 4));   // ease the effects in/out
    sc.shared.uAlive.value = aliveLevel;
    sc.dust.uniforms.uTime.value = t;

    if (tween) {                                   // animated "Front view"
      const k = easeIO((now - tween.t0) / tween.dur);
      sph.set(tween.r0 + (tween.r1 - tween.r0) * k, tween.phi0 + (tween.phi1 - tween.phi0) * k, tween.theta0 + tween.dTheta * k);
      camera.position.setFromSpherical(sph).add(target);
      if (now - tween.t0 >= tween.dur) tween = null;
    }
    controls.autoRotate = spinOn && !tween && now >= resumeAt;
    controls.update(dt);                           // dt keeps the turntable speed frame-rate independent

    // key light: up-left of the camera, so every side of the object is lit when you look at it
    camera.matrixWorld.extractBasis(camRight, camUp, camBack);
    sc.shared.uKey.value.set(0, 0, 0).addScaledVector(camRight, -0.45).addScaledVector(camUp, 0.65).addScaledVector(camBack, 0.75).normalize();
    sc.sun.position.copy(sc.shared.uKey.value).multiplyScalar(10).add(target);

    // intro: layers rise from the flat page into place, one after another (about 1.2 s)
    // (front layers start first, so a rising layer can never pass through the ones above it)
    const last = sc.meshes.length - 1;
    sc.meshes.forEach((m, i) => { m.position.z = i * 0.0015 + (i * sc.thick - i * 0.0015) * easeOut((t - 0.1 - (last - i) * 0.035) / 0.7); });
    renderer.render(sc.scene, camera);
  }
  raf = requestAnimationFrame(frame);
  setTimeout(() => tip.classList.add("is-gone"), 7000);
  const api = { close, stats, setView, get camera() { return camera; } };
  current.api = api;
  return api;
}

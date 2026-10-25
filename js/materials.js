/* materials.js — PBR materials, procedural textures and a dim cinema PMREM environment.
   export createMaterials({ THREE, renderer }) → M   (synchronous; all work happens at load, nothing per frame)
   Every texture is canvas-generated: tileable value-noise/fbm fields shared by all maps, Sobel height→normal.

   ───────────────────────────── UV CONVENTION (read me, hall.js / seats.js) ─────────────────────────────
   Large surfaces use WORLD-SPACE UVs in metres (hall.js: u = x, v = z on floors/tiers; u = x|z, v = y on
   walls). The repeats below convert metres → tiles, so one material is correct on the floor, every riser
   front, the landing and the stage at once:
     carpet        1 tile = 1.0 m  (trellis of 12.5 cm diamonds)              repeat (1, 1)
     carpetAisle   1 tile = 0.6 m  diamond lattice, direction-agnostic, NO border stripe (U is x in metres on the
                   runners, so a bordered runner could not align) — reads the same on runners and cross-aisles
                                                                              repeat (1/0.6, 1/0.6)
     wallPanel     1 tile = 0.5 m  weave (256 threads/m) + soft undulation    repeat (2, 2)
     wallDark      normal only, same 0.5 m tile                               repeat (2, 2)
     ceiling       faint normal mottle, 1 tile = 1 m                          repeat (1, 1)
     wood          planks 18 cm wide across V (6 per tile), 2.4 m long along U; grain runs along U
                   (U = x on the stage top)                                   repeat (1/2.4, 1/1.08)
   Seat velvet (seats.js writes 4 uv units per metre): 1 tile = 1 uv = 25 cm  repeat (1, 1)
   curtain: plane UV 0..1 over 1.35 × 7.1 m → pile normal repeat (2, 10)
   brass / blackMetal / seatFrame / armrest: small parts with default 0..1 UVs; their roughness/normal repeats
   are tuned for that. Any OTHER geometry with 0..1 UVs: M.withRepeat(mat, rx, ry) → clone re-tiled
   (rx = width / tile, ry = depth / tile), e.g. M.withRepeat(M.carpet, 16, 1.15) for a 16 × 1.15 m plane.

   ───────────────────────────── EXTRA EXPORTS (beyond the contract) ─────────────────────────────
     M.sconceShade   MeshStandardMaterial — warm lit sconce glass (emissive 1.6 → gentle bloom). Use it for
                     sconce shades instead of building your own.
     M.seatPlate     alias of M.brass (row / seat number plates).
     M.seatFabricLow, M.curtainLow  MeshStandardMaterial twins of the MeshPhysical (sheen) velvet materials.
     M.setQuality('high'|'low', root?)  swaps M.seatFabric / M.curtain between the sheen and plain variants.
                     Call it right after createMaterials (before buildHall / buildSeats) to affect what they
                     build; pass a scene/Object3D to also swap the material on meshes already built.
     M.quality       'high' | 'low'.
     M.withRepeat(material, rx, ry = rx)  clone of a material with every map re-tiled (shares GPU images).
     M.maxAnisotropy the renderer maximum (colour maps use min(max, 8), data maps min(max, 4)).
     M.textures, M.materials  name → object registries;  M._envRT the PMREM render target;  M.dispose(). */
import * as THREE_ from 'three';

const SIZE = 512;            // colour / normal / roughness maps
const SMALL = 256;           // roughness-only maps
const TAU = Math.PI * 2;

/* env radiance (linear) of the emitters in the PMREM scene — warm lines dominate so brass reads warm */
const ENV_COVE = 5.0, ENV_LINE = 6.0, ENV_SCONCE = 2.5, ENV_SCREEN = 0.5;

/* ---------- small math ---------- */
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const lerp = (a, b, t) => a + (b - a) * t;
const fract = x => x - Math.floor(x);
const sstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

function hash(ix, iy, seed) {
  let h = (Math.imul(ix, 374761393) + Math.imul(iy, 668265263) + Math.imul(seed, 1274126177)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1103515245);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/* value noise on a lattice wrapped to px × py cells → seamless tile */
function vnoise(x, y, px, py, seed) {
  const xi = Math.floor(x), yi = Math.floor(y);
  let fx = x - xi, fy = y - yi;
  fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy);
  const x0 = ((xi % px) + px) % px, y0 = ((yi % py) + py) % py;
  const x1 = (x0 + 1) % px, y1 = (y0 + 1) % py;
  const a = hash(x0, y0, seed), b = hash(x1, y0, seed), c = hash(x0, y1, seed), d = hash(x1, y1, seed);
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
}

/* fbm over a size² tile with px × py base cells, remapped to [0,1] */
function fbmField(size, px, py, oct, seed, gain = 0.5) {
  const f = new Float32Array(size * size);
  let lo = Infinity, hi = -Infinity;
  for (let y = 0, i = 0; y < size; y++) {
    const v = y / size;
    for (let x = 0; x < size; x++, i++) {
      const u = x / size;
      let amp = 1, sum = 0, norm = 0, cx = px, cy = py;
      for (let o = 0; o < oct; o++) {
        sum += amp * vnoise(u * cx, v * cy, cx, cy, seed + o * 17);
        norm += amp; amp *= gain; cx *= 2; cy *= 2;
      }
      const s = sum / norm;
      f[i] = s; if (s < lo) lo = s; if (s > hi) hi = s;
    }
  }
  const k = 1 / Math.max(1e-6, hi - lo);
  for (let i = 0; i < f.length; i++) f[i] = (f[i] - lo) * k;
  return f;
}

/* bilinear, wrap-around upsample of an s² field to size² (slow low-frequency fields are built small) */
function upsample(src, s, size) {
  if (s === size) return src;
  const out = new Float32Array(size * size), k = s / size;
  for (let y = 0, i = 0; y < size; y++) {
    const fy = y * k, y0 = Math.floor(fy), ty = fy - y0, r0 = y0 * s, r1 = ((y0 + 1) % s) * s;
    for (let x = 0; x < size; x++, i++) {
      const fx = x * k, x0 = Math.floor(fx), tx = fx - x0, x1 = (x0 + 1) % s;
      const a = src[r0 + x0], b = src[r0 + x1], c = src[r1 + x0], d = src[r1 + x1];
      out[i] = a + (b - a) * tx + (c - a) * ty + (a - b - c + d) * tx * ty;
    }
  }
  return out;
}

function whiteField(size, seed) {
  const f = new Float32Array(size * size);
  for (let y = 0, i = 0; y < size; y++) for (let x = 0; x < size; x++, i++) f[i] = hash(x, y, seed);
  return f;
}

/* 3×3 box blur with wrap */
function blur3(src, size) {
  const out = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    const yu = ((y - 1 + size) % size) * size, y0 = y * size, yd = ((y + 1) % size) * size;
    for (let x = 0; x < size; x++) {
      const xl = (x - 1 + size) % size, xr = (x + 1) % size;
      out[y0 + x] = (src[yu + xl] + src[yu + x] + src[yu + xr] + src[y0 + xl] + src[y0 + x] + src[y0 + xr] +
        src[yd + xl] + src[yd + x] + src[yd + xr]) / 9;
    }
  }
  return out;
}

/* ---------- canvas → texture ---------- */
function makeTexture(THREE, size, maxAniso, fill, opts = {}) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(size, size);
  fill(img.data, size);
  ctx.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(canvas);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(opts.rx ?? 1, opts.ry ?? 1);
  t.anisotropy = Math.max(1, Math.min(maxAniso, opts.srgb ? 8 : 4));      // colour 8×, data maps 4× (fill-rate on Iris Plus)
  t.colorSpace = opts.srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;   // data maps stay linear
  t.name = opts.name || '';
  return t;
}

const put = (d, i, r, g, b) => { d[i] = clamp(r, 0, 255); d[i + 1] = clamp(g, 0, 255); d[i + 2] = clamp(b, 0, 255); d[i + 3] = 255; };
const putGrey = (d, i, v) => { const b = clamp(v * 255, 0, 255); d[i] = d[i + 1] = d[i + 2] = b; d[i + 3] = 255; };

/* Sobel-style central differences, OpenGL (+Y up) tangent space; flipY=true keeps image-up = +v */
function normalFill(h, size, strength) {
  return d => {
    for (let y = 0, i = 0; y < size; y++) {
      const yu = ((y - 1 + size) % size) * size, y0 = y * size, yd = ((y + 1) % size) * size;
      for (let x = 0; x < size; x++, i += 4) {
        const xl = (x - 1 + size) % size, xr = (x + 1) % size;
        const nx = -(h[y0 + xr] - h[y0 + xl]) * 0.5 * strength;
        const ny = (h[yd + x] - h[yu + x]) * 0.5 * strength;
        const inv = 127 / Math.sqrt(nx * nx + ny * ny + 1);
        d[i] = 128 + nx * inv; d[i + 1] = 128 + ny * inv; d[i + 2] = 128 + inv; d[i + 3] = 255;
      }
    }
  };
}

const hexR = h => (h >> 16) & 255, hexG = h => (h >> 8) & 255, hexB = h => h & 255;

/* diamond trellis: distance-to-line mask and centre-dot mask (written to TL / TD, no allocation) */
let TL = 0, TD = 0;
function trellis(u, v, cells) {
  const p = fract((u + v) * cells), q = fract((u - v) * cells);
  const dp = Math.min(p, 1 - p), dq = Math.min(q, 1 - q);
  TL = Math.max(1 - sstep(0.018, 0.042, dp), 1 - sstep(0.018, 0.042, dq));
  TD = 1 - sstep(0.07, 0.10, Math.hypot(p - 0.5, q - 0.5));
}

/* =================================================================== */
export function createMaterials({ THREE = THREE_, renderer } = {}) {
  const aniso = Math.max(1, (renderer && renderer.capabilities && renderer.capabilities.getMaxAnisotropy &&
    renderer.capabilities.getMaxAnisotropy()) || 1);

  const textures = {}, materials = {}, derived = [];
  const tex = (name, size, fill, opts = {}) => (textures[name] = makeTexture(THREE, size, aniso, fill, { name, ...opts }));

  /* ---------- shared noise fields (computed once, reused by every map; slow fields built small + upsampled) ---------- */
  const N = SIZE * SIZE;
  const F_soft = upsample(fbmField(256, 6, 6, 4, 11), 256, SIZE);   // blotches / crushed pile / wear
  const F_low = upsample(fbmField(64, 2, 2, 2, 13), 64, SIZE);      // very slow tint drift
  const W = whiteField(SIZE, 7);                                    // per-pixel white noise
  const Wb = blur3(W, SIZE);                                        // softened white noise (velvet pile)
  const F_fine = fbmField(SIZE, 48, 48, 2, 29);                     // fibre grain: 2 fbm octaves + Wb as the finest octave
  for (let i = 0; i < N; i++) F_fine[i] = clamp(F_fine[i] * 0.8 + (Wb[i] - 0.5) * 0.4 + 0.1, 0, 1);
  const G_warp = upsample(fbmField(128, 2, 6, 3, 41), 128, SIZE);   // slow warp for wood grain lines
  const G_pore = fbmField(SIZE, 4, 128, 1, 43);                     // long pores along the plank (one octave is enough for streaks)
  const B_brush = fbmField(SMALL, 3, 96, 2, 53);                    // brushed-metal streaks

  /* ---------- velvet: near-white mottle (instance colours tint it), pile normal, roughness ----------
     crushed-pile mottling −12 %, fibre ±1.5 %, slow warm/cool tilt ±4 % so neighbouring areas differ */
  const hV = new Float32Array(N);
  tex('velvetMap', SIZE, (d, s) => {
    for (let p = 0, i = 0; p < N; p++, i += 4) {
      const crush = sstep(0.45, 0.9, F_soft[p]);
      const t = (F_low[p] - 0.5) * 2;                                // -1..1
      const g = (0.985 - 0.12 * crush + (F_fine[p] - 0.5) * 0.03) * 255;
      put(d, i, g * (1 + 0.04 * t), g * (1 + 0.01 * t), g * (1 - 0.03 * t));
      hV[p] = 0.55 * F_fine[p] + 0.30 * Wb[p] + 0.15 * F_soft[p];
    }
  }, { srgb: true, rx: 1, ry: 1 });
  tex('velvetNormal', SIZE, normalFill(hV, SIZE, 4.0), { rx: 1, ry: 1 });
  tex('velvetRough', SIZE, (d, s) => {
    for (let p = 0, i = 0; p < N; p++, i += 4)
      putGrey(d, i, clamp(0.85 + (F_fine[p] - 0.5) * 0.14 - 0.12 * sstep(0.55, 0.8, F_soft[p]), 0.66, 0.93));
  }, { rx: 1, ry: 1 });

  /* ---------- carpet: dark trellis with a centre dot (1 m tile) / aisle: diamond lattice (0.6 m tile) ----------
     albedo ≈ sRGB 45–50 (linear ~3 %): dark enough to stay cinematic, bright enough to read under the step lights */
  const carpetFill = (baseHex, lineHex, dotHex, aisle) => {
    const h = new Float32Array(N);
    const fill = (d, s) => {
      const br = hexR(baseHex), bg = hexG(baseHex), bb = hexB(baseHex);
      const lr = hexR(lineHex), lg = hexG(lineHex), lb = hexB(lineHex);
      const dr = hexR(dotHex), dg = hexG(dotHex), db = hexB(dotHex);
      for (let y = 0, p = 0, i = 0; y < s; y++) {
        const v = y / s;
        for (let x = 0; x < s; x++, p++, i += 4) {
          const u = x / s;
          let r, g, b, hh;
          if (!aisle) {
            trellis(u, v, 8);
            r = lerp(br, lr, TL * 0.7); g = lerp(bg, lg, TL * 0.7); b = lerp(bb, lb, TL * 0.7);
            r = lerp(r, dr, TD * 0.8); g = lerp(g, dg, TD * 0.8); b = lerp(b, db, TD * 0.8);
            hh = 0.5 - TL * 0.5 - TD * 0.3;
          } else {
            /* lattice: large outlined diamond at the tile centre + small filled diamonds on the corners.
               Symmetric in u and v → seamless and orientation-free (works with u = x metres on every aisle) */
            const dd = (Math.abs(u - 0.5) + Math.abs(v - 0.5)) / 0.42;             // L1 radius, 1 = diamond edge
            const outer = 1 - sstep(0.90, 1.0, dd), inner = 1 - sstep(0.76, 0.84, dd);
            const ring = outer - inner;
            const cd = (Math.min(u, 1 - u) + Math.min(v, 1 - v)) / 0.11;             // corner diamonds
            const dot = 1 - sstep(0.78, 1.0, cd);
            r = lerp(br, lr, inner * 0.6); g = lerp(bg, lg, inner * 0.6); b = lerp(bb, lb, inner * 0.6);
            const k = Math.max(ring, dot);
            r = lerp(r, dr, k); g = lerp(g, dg, k); b = lerp(b, db, k);
            hh = 0.5 - k * 0.45 - inner * 0.1;
          }
          if (W[p] > 0.994) { r = 150; g = 118; b = 60; }                  // gold specks
          const f = 1 + (F_fine[p] - 0.5) * 0.14 + (F_soft[p] - 0.5) * 0.10;  // fibre + wear
          put(d, i, r * f, g * f, b * f);
          h[p] = hh + (F_fine[p] - 0.5) * 0.35;
        }
      }
    };
    return { fill, h };
  };
  const cf = carpetFill(0x34232b, 0x523a44, 0x64482f, false);
  tex('carpetMap', SIZE, cf.fill, { srgb: true, rx: 1, ry: 1 });                 // 1 tile = 1 m (metre UVs)
  tex('carpetNormal', SIZE, normalFill(cf.h, SIZE, 2.0), { rx: 1, ry: 1 });
  const AISLE_TILE = 0.6, ar = 1 / AISLE_TILE;
  const af = carpetFill(0x2e1e22, 0x4a2e34, 0x8a6236, true);
  tex('carpetAisleMap', SIZE, af.fill, { srgb: true, rx: ar, ry: ar });          // 1 tile = 0.6 m (metre UVs)
  tex('carpetAisleNormal', SIZE, normalFill(af.h, SIZE, 2.0), { rx: ar, ry: ar });

  /* ---------- acoustic wall fabric: fine weave (128 threads per 0.5 m tile) + soft undulation; albedo ≈ sRGB 44 ---------- */
  const hW = new Float32Array(N);
  tex('wallMap', SIZE, (d, s) => {
    for (let y = 0, p = 0, i = 0; y < s; y++) {
      const sv = Math.sin((y / s) * TAU * 128);
      for (let x = 0; x < s; x++, p++, i += 4) {
        const weave = Math.sin((x / s) * TAU * 128) * sv;
        const f = 1 + weave * 0.08 + (F_fine[p] - 0.5) * 0.07 + (F_soft[p] - 0.5) * 0.06;
        put(d, i, 44 * f, 40 * f, 46 * f);
        hW[p] = 0.5 + weave * 0.3 + (F_soft[p] - 0.5) * 0.5 + (F_fine[p] - 0.5) * 0.15;
      }
    }
  }, { srgb: true, rx: 2, ry: 2 });                                              // 1 tile = 0.5 m (metre UVs)
  tex('wallNormal', SIZE, normalFill(hW, SIZE, 1.5), { rx: 2, ry: 2 });

  /* ---------- dark walnut planks: 6 across V per tile, warped grain lines along U ---------- */
  const hWd = new Float32Array(N), rWd = new Float32Array(N);
  tex('woodMap', SIZE, (d, s) => {
    for (let y = 0, p = 0, i = 0; y < s; y++) {
      const v = y / s, plank = Math.floor(v * 6), pv = fract(v * 6);
      const seed = hash(plank, 3, 5), seed2 = hash(plank, 9, 5);
      const seamV = 1 - sstep(0, 0.02, Math.min(pv, 1 - pv));
      const br = lerp(43, 58, seed), bg = lerp(26, 36, seed), bb = lerp(18, 24, seed);
      for (let x = 0; x < s; x++, p++, i += 4) {
        const u = x / s;
        let g = 0.5 + 0.5 * Math.sin((pv * 7 + 1.6 * G_warp[p] + seed * 10) * TAU);
        g = g * g * g;                                                      // thin dark grain lines
        const eu = fract(u + seed2), seamU = 1 - sstep(0, 0.004, Math.min(eu, 1 - eu));
        const seam = Math.max(seamV, seamU);
        const pore = G_pore[p];
        let r = lerp(br, 26, g * 0.7), gg = lerp(bg, 15, g * 0.7), b = lerp(bb, 10, g * 0.7);
        const f = 1 + (pore - 0.5) * 0.12 + (F_fine[p] - 0.5) * 0.05;
        r *= f; gg *= f; b *= f;
        put(d, i, lerp(r, 14, seam), lerp(gg, 8, seam), lerp(b, 6, seam));
        hWd[p] = 0.6 - seam * 0.6 - g * 0.3 + (pore - 0.5) * 0.12;
        rWd[p] = clamp(0.55 + 0.12 * g + (pore - 0.5) * 0.08 + seam * 0.2, 0.3, 0.95);
      }
    }
  }, { srgb: true, rx: 1 / 2.4, ry: 1 / 1.08 });                                 // planks 2.4 m × 18 cm (metre UVs)
  tex('woodNormal', SIZE, normalFill(hWd, SIZE, 2.5), { rx: 1 / 2.4, ry: 1 / 1.08 });
  tex('woodRough', SIZE, d => { for (let p = 0, i = 0; p < N; p++, i += 4) putGrey(d, i, rWd[p]); }, { rx: 1 / 2.4, ry: 1 / 1.08 });

  /* ---------- roughness-only helpers ---------- */
  tex('brassRough', SMALL, d => {
    const n = SMALL * SMALL;
    for (let p = 0, i = 0; p < n; p++, i += 4) putGrey(d, i, 0.22 + 0.16 * B_brush[p] + hash(p, 1, 3) * 0.03);
  }, { rx: 4, ry: 1 });
  tex('noiseRough', SMALL, d => {
    for (let y = 0, i = 0; y < SMALL; y++) for (let x = 0; x < SMALL; x++, i += 4) {
      const p = (y * 2) * SIZE + x * 2;
      putGrey(d, i, 0.40 + 0.20 * (0.6 * F_fine[p] + 0.4 * W[p]));
    }
  }, { rx: 2, ry: 2 });

  const T = textures;
  const cloneRepeat = (t, rx, ry) => { const c = t.clone(); c.repeat.set(rx, ry); derived.push(c); return c; };

  /* ---------- materials ---------- */
  const mat = (name, m) => { m.name = name; materials[name] = m; return m; };
  const V2 = (x, y) => new THREE.Vector2(x, y);

  /* velvet: sheen (MeshPhysical) and plain (MeshStandard) twins — M.setQuality picks; normalScale ≤ 0.5 so the
     mip-filtered pile does not sparkle on 140 instances */
  const velvetBase = () => ({
    color: 0xffffff, map: T.velvetMap, roughness: 1, roughnessMap: T.velvetRough, metalness: 0,
    normalMap: T.velvetNormal, normalScale: V2(0.45, 0.45), envMapIntensity: 0.35 });
  const seatFabricHi = mat('seatFabric', new THREE.MeshPhysicalMaterial({
    ...velvetBase(), sheen: 0.3, sheenRoughness: 0.75, sheenColor: 0xe6d2c8 }));
  const seatFabricLow = mat('seatFabricLow', new THREE.MeshStandardMaterial(velvetBase()));

  const seatFrame = mat('seatFrame', new THREE.MeshStandardMaterial({
    color: 0x1a1a1e, metalness: 0.6, roughness: 1, roughnessMap: T.noiseRough, envMapIntensity: 0.8 }));

  const armrest = mat('armrest', new THREE.MeshStandardMaterial({
    color: 0x15131a, roughness: 0.5, metalness: 0.05,
    normalMap: cloneRepeat(T.velvetNormal, 2, 2), normalScale: V2(0.35, 0.35), envMapIntensity: 0.5 }));

  const carpet = mat('carpet', new THREE.MeshStandardMaterial({
    color: 0xffffff, map: T.carpetMap, normalMap: T.carpetNormal, normalScale: V2(0.5, 0.5),
    roughness: 1, metalness: 0, envMapIntensity: 0.25 }));

  const carpetAisle = mat('carpetAisle', new THREE.MeshStandardMaterial({
    color: 0xffffff, map: T.carpetAisleMap, normalMap: T.carpetAisleNormal, normalScale: V2(0.5, 0.5),
    roughness: 1, metalness: 0, envMapIntensity: 0.25 }));

  const wallPanel = mat('wallPanel', new THREE.MeshStandardMaterial({
    color: 0xffffff, map: T.wallMap, normalMap: T.wallNormal, normalScale: V2(0.45, 0.45),
    roughness: 0.95, metalness: 0, envMapIntensity: 0.3 }));

  const wallDark = mat('wallDark', new THREE.MeshStandardMaterial({
    color: 0x1c1a1f, roughness: 0.95, metalness: 0,
    normalMap: cloneRepeat(T.wallNormal, 2, 2), normalScale: V2(0.3, 0.3), envMapIntensity: 0.2 }));

  const ceiling = mat('ceiling', new THREE.MeshStandardMaterial({
    color: 0x17161b, roughness: 0.92, metalness: 0,
    normalMap: cloneRepeat(T.wallNormal, 1, 1), normalScale: V2(0.25, 0.25), envMapIntensity: 0.2 }));

  const wood = mat('wood', new THREE.MeshStandardMaterial({
    color: 0xffffff, map: T.woodMap, normalMap: T.woodNormal, normalScale: V2(0.5, 0.5),
    roughness: 1, roughnessMap: T.woodRough, metalness: 0, envMapIntensity: 0.6 }));

  const brass = mat('brass', new THREE.MeshStandardMaterial({
    color: 0xd4ad5c, metalness: 0.95, roughness: 1, roughnessMap: T.brassRough,
    emissive: 0x5a3a14, emissiveIntensity: 0.6, envMapIntensity: 1.3 }));     // emissive keeps trim alive in shadow (lum ≈ 0.07, far below bloom)

  const blackMetal = mat('blackMetal', new THREE.MeshStandardMaterial({
    color: 0x0c0c0f, metalness: 0.7, roughness: 1, roughnessMap: T.noiseRough, envMapIntensity: 0.6 }));

  const curtainPile = cloneRepeat(T.velvetNormal, 2, 10);
  const curtainBase = () => ({
    color: 0x6e1420, roughness: 0.9, metalness: 0, normalMap: curtainPile, normalScale: V2(0.5, 0.5),
    envMapIntensity: 0.35, side: THREE.DoubleSide });
  const curtainHi = mat('curtain', new THREE.MeshPhysicalMaterial({
    ...curtainBase(), sheen: 0.35, sheenRoughness: 0.7, sheenColor: 0xff8a80 }));
  const curtainLow = mat('curtainLow', new THREE.MeshStandardMaterial(curtainBase()));

  const screenFrame = mat('screenFrame', new THREE.MeshStandardMaterial({
    color: 0x08080a, roughness: 0.85, metalness: 0.1, envMapIntensity: 0.15 }));

  /* glowing surfaces: HDR colours (> 1 in linear) so the bloom pass (threshold ≈ 0.85) picks them up */
  const emissiveWarm = mat('emissiveWarm', new THREE.MeshBasicMaterial({ color: new THREE.Color(0xffe4bf).multiplyScalar(2.5) }));
  const emissiveBrass = mat('emissiveBrass', new THREE.MeshBasicMaterial({ color: new THREE.Color(0xf0cf7a).multiplyScalar(1.8) }));
  const exitGreen = mat('exitGreen', new THREE.MeshBasicMaterial({ color: new THREE.Color(0x3dff8a).multiplyScalar(1.6) }));

  /* extra: warm sconce glass (lit shade, gentle bloom) */
  const sconceShade = mat('sconceShade', new THREE.MeshStandardMaterial({
    color: 0xffc98a, emissive: 0xffb070, emissiveIntensity: 1.6, roughness: 0.6, metalness: 0, envMapIntensity: 0.2 }));

  /* ---------- dim cinema environment (PMREM of a hand-built emissive room) ----------
     warm vertical LED lines every 2 m + warm coves dominate the radiance; the screen is a dim cool rectangle,
     so brass picks up warm reflections instead of a big blue blob */
  let env = null, envRT = null;
  if (renderer) {
    const envScene = new THREE.Scene();
    const geos = [], mats = [];
    const add = (geo, color, x, y, z, side) => {
      const m = new THREE.MeshBasicMaterial({ color, side: side || THREE.FrontSide });
      const mesh = new THREE.Mesh(geo, m);
      mesh.position.set(x, y, z);
      envScene.add(mesh); mats.push(m);
      return mesh;
    };
    const hdr = (hex, k) => new THREE.Color(hex).multiplyScalar(k);
    try {
      const gBox = new THREE.BoxGeometry(20, 8, 24), gFloor = new THREE.PlaneGeometry(20, 24);
      const gCove = new THREE.BoxGeometry(0.2, 0.05, 22), gLine = new THREE.BoxGeometry(0.06, 7, 0.06);
      const gSconce = new THREE.SphereGeometry(0.3, 12, 8), gScreen = new THREE.PlaneGeometry(12, 5.2);
      geos.push(gBox, gFloor, gCove, gLine, gSconce, gScreen);
      add(gBox, 0x1a1411, 0, 0, 0, THREE.BackSide);                                   // warm dark room shell
      add(gFloor, 0x1a1210, 0, -3.95, 0).rotation.x = -Math.PI / 2;                   // floor
      for (const x of [-5, 0, 5]) add(gCove, hdr(0xffd9a8, ENV_COVE), x, 3.9, 0);       // ceiling cove strips
      for (const sx of [-1, 1]) {
        for (let z = -10; z <= 10; z += 2) add(gLine, hdr(0xffc98a, ENV_LINE), sx * 9.95, 0, z);   // vertical LED lines
        for (const z of [-6, 0, 6]) add(gSconce, hdr(0xffb878, ENV_SCONCE), sx * 9.6, 1.5, z);     // sconces
      }
      add(gScreen, hdr(0x9fb8d8, ENV_SCREEN), 0, 0.3, -11.9);                          // dim cool screen glow
      const pmrem = new THREE.PMREMGenerator(renderer);
      envRT = pmrem.fromScene(envScene, 0.04);
      pmrem.dispose();
      env = envRT.texture;
      env.name = 'cinemaEnv';
    } catch (e) {
      console.warn('[materials] environment map skipped:', e);
      if (envRT) { envRT.dispose(); envRT = null; }
      env = null;
    }
    for (const g of geos) g.dispose();
    for (const m of mats) m.dispose();
  }

  /* ---------- API ---------- */
  const MAP_KEYS = ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'emissiveMap', 'aoMap', 'bumpMap', 'sheenColorMap'];
  /* clone a material with its textures re-tiled (clones share the GPU image via Source — no re-upload) */
  function withRepeat(material, rx, ry = rx) {
    const m = material.clone();
    for (const k of MAP_KEYS) {
      const t = m[k];
      if (t && t.isTexture) m[k] = cloneRepeat(t, rx, ry);
    }
    m.name = material.name + `@${rx}x${ry}`;
    derived.push(m);
    return m;
  }

  /* swap sheen ↔ plain velvet. Affects what later builders read from M; with a root object, also re-points
     meshes already built (one traversal, no re-upload: both variants share the same textures) */
  const QUALITY_PAIRS = [[seatFabricHi, seatFabricLow], [curtainHi, curtainLow]];
  function setQuality(q, root) {
    const low = q === 'low';
    M.quality = low ? 'low' : 'high';
    M.seatFabric = low ? seatFabricLow : seatFabricHi;
    M.curtain = low ? curtainLow : curtainHi;
    if (root && typeof root.traverse === 'function') {
      root.traverse(o => {
        if (!o.isMesh || !o.material) return;
        for (const [hi, lo] of QUALITY_PAIRS) {
          if (o.material === (low ? hi : lo)) o.material = low ? lo : hi;
        }
      });
    }
    return M;
  }

  function dispose() {
    for (const k in textures) textures[k].dispose();
    for (const k in materials) materials[k].dispose();
    for (const o of derived) o.dispose();
    derived.length = 0;
    if (envRT) { envRT.dispose(); envRT = null; }
    env = M.env = M._envRT = null;
  }

  const M = {
    seatFabric: seatFabricHi, seatFrame, armrest,
    carpet, carpetAisle,
    wallPanel, wallDark, ceiling,
    wood, brass, blackMetal,
    curtain: curtainHi, screenFrame,
    emissiveWarm, emissiveBrass, exitGreen,
    sconceShade, seatPlate: brass,
    seatFabricLow, curtainLow, quality: 'high', setQuality,
    env, _envRT: envRT,
    textures, materials,
    maxAnisotropy: aniso,
    withRepeat, dispose,
  };
  return M;
}

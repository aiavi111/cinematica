// screen.js — what the projector shows. A looping 3-shot "trailer" per movie drawn with Canvas 2D into a
// CanvasTexture, a cheap brightness estimate so the hall can be lit by the picture, and the showtime clock dial.
// Only core 'three' is used (CanvasTexture, Color, constants); every pixel is procedural, nothing is fetched.
import * as THREE_ from 'three';

/* ---------- geometry of the picture ---------- */
const TW = 1024, TH = 576;                      // texture size (contract)
const SCREEN_ASPECT = 12 / 5.2;                 // hall.screen mesh ratio: a 16:9 texture lands 1.3× wider on it
const BAR = 12, PH = TH - 2 * BAR;              // 2.39:1 letterbox bars and the picture height (552)
let VW = Math.round(TW * SCREEN_ASPECT / (16 / 9)); // 1328: virtual width in which everything is drawn undistorted
let PW = VW;                                    // picture width in virtual space
const LW = 1514, LH = 618;                      // oversized layer canvases (room for pan / zoom at scale ≤ 1.35)
const HW = LW >> 1, HH = LH >> 1;               // half-resolution soft layers (gradients, glows, haze)
let LX = -(LW - PW) / 2;                        // layer origin in picture space (-93, -33)
const LY = -(LH - PH) / 2;
const TAU = Math.PI * 2;

/* ---------- timeline (seconds) ---------- */
const LOOP = 14, S1 = 5.4, S2 = 10.2, XF = 0.6, DIP = 0.4, SWITCH = 0.45;

/* ---------- typography ---------- */
const F_TITLE = '"Inter",system-ui,-apple-system,"Segoe UI",Roboto,sans-serif';
const F_UI = '"Inter",system-ui,-apple-system,"Segoe UI",Roboto,sans-serif';

/* ---------- small helpers (pure) ---------- */
const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
const mod = (v, m) => ((v % m) + m) % m;
const smooth = (a, b, x) => { x = clamp((x - a) / (b - a), 0, 1); return x * x * (3 - 2 * x); };
const easeIO = k => k < .5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
const easeOut = k => 1 - Math.pow(1 - k, 3);
function hash(i) { i |= 0; i = Math.imul(i ^ (i >>> 16), 0x45d9f3b); i = Math.imul(i ^ (i >>> 16), 0x45d9f3b); i ^= i >>> 16; return (i >>> 0) / 4294967296; }
function noise1d(x) { const i = Math.floor(x), f = x - i, u = f * f * (3 - 2 * f), a = hash(i); return a + (hash(i + 1) - a) * u; }
function strHash(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
function rng(seed) { return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
function mkCanvas(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
const c2d = c => c.getContext('2d');
function rgba(hex, a) { const m = /^#?([0-9a-f]{6})$/i.exec(hex); if (!m) return hex; const n = parseInt(m[1], 16); return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`; }
const pal = m => (m.palette && m.palette.length >= 3) ? m.palette : ['#0a0f2a', '#3b1a3a', '#ff7a2a'];
function fontOk(spec) { try { return !document.fonts || document.fonts.check(spec); } catch (_) { return true; } }

// Letter-spaced text drawn glyph by glyph (works in every browser). align: 'left' | 'center' | 'right'.
function spacedWidth(c, str, sp) { let w = 0; for (let i = 0; i < str.length; i++) w += c.measureText(str[i]).width; return w + sp * (str.length - 1); }
function spacedText(c, str, x, y, sp, align) {
  const w = spacedWidth(c, str, sp);
  let px = align === 'center' ? x - w / 2 : align === 'right' ? x - w : x;
  const ta = c.textAlign; c.textAlign = 'left';
  for (let i = 0; i < str.length; i++) { const ch = str[i]; c.fillText(ch, px, y); px += c.measureText(ch).width + sp; }
  c.textAlign = ta; return w;
}
// Float32Array of particles, 6 floats each: x0, y0, vx, vy, size, phase.
function particles(n, r, fill) { const P = new Float32Array(n * 6); for (let i = 0; i < n; i++) fill(P, i * 6, r); return P; }
function radial(c, x, y, r0, r1, stops) { const g = c.createRadialGradient(x, y, r0, x, y, r1); for (let i = 0; i < stops.length; i += 2) g.addColorStop(stops[i], stops[i + 1]); return g; }
function linear(c, x0, y0, x1, y1, stops) { const g = c.createLinearGradient(x0, y0, x1, y1); for (let i = 0; i < stops.length; i += 2) g.addColorStop(stops[i], stops[i + 1]); return g; }

/* ---------- per-frame drawing state (one screen per page) ---------- */
let ctx = null;        // main 1024×576 context, transformed into virtual picture space while drawing
let S = null;          // shared assets: vignette, card shade, grain patterns, glow sprite
let A = 1;             // alpha multiplier of the shot being drawn (cross-dissolve / card backdrop)
let quality = 'high';  // 'low' drops grain blending, half the particles and the shimmer slices
let frame = 0, heavy = false; // heavy: this frame built a cache, keep it out of the cost average
const setA = a => { ctx.globalAlpha = A * a; };
const pstep = () => quality === 'low' ? 12 : 6;

// Virtual camera: uniform zoom about the picture centre plus a vertical offset. Pan is applied per layer (parallax).
function cam(s, ty) { const cx = PW / 2, cy = PH / 2; ctx.save(); ctx.translate(cx, cy); ctx.scale(s, s); ctx.translate(-cx, -cy + ty); }
function uncam() { ctx.restore(); }
// Draws an oversized layer (full or half resolution) with parallax factor k for pan tx.
function layer(img, k, tx, ty) { ctx.drawImage(img, LX + tx * k, LY + (ty || 0), LW, LH); }
// Horizontal slices of a layer re-drawn with a sinusoidal x offset — heat shimmer along a band of layer rows.
function shimmer(img, k, tx, y0, t) {
  if (quality === 'low') return;
  for (let i = 0; i < 8; i++) { const sy = y0 + i * 6; ctx.drawImage(img, 0, sy, LW, 6, LX + tx * k + Math.sin(t * 5 + i) * 1.5, LY + sy, LW, 6); }
}
// Drifting square motes wrapped inside the picture; alpha breathes per particle.
function motes(P, t, color, a0, tx) {
  ctx.fillStyle = color;
  for (let i = 0, st = pstep(); i < P.length; i += st) {
    const x = mod(P[i] + P[i + 2] * t, PW + 40) - 20 + tx, y = mod(P[i + 1] + P[i + 3] * t, PH + 40) - 20, sz = P[i + 4];
    setA(a0 * (0.6 + 0.4 * Math.sin(t * 2 + P[i + 5])));
    ctx.fillRect(x, y, sz, sz);
  }
}

/* ---------- shared assets ---------- */
function buildShared(mainCtx) {
  const vig = mkCanvas(PW, PH), v = c2d(vig);
  v.fillStyle = radial(v, PW / 2, PH / 2, PH * 0.35, PW * 0.62, [0, 'rgba(0,0,0,0)', 1, 'rgba(0,0,0,0.6)']); v.fillRect(0, 0, PW, PH);
  v.fillStyle = linear(v, 0, 0, 0, PH, [0, 'rgba(0,0,0,.25)', .18, 'rgba(0,0,0,0)', .82, 'rgba(0,0,0,0)', 1, 'rgba(0,0,0,.25)']); v.fillRect(0, 0, PW, PH);
  const shade = mkCanvas(PW, PH), sc = c2d(shade);           // key-art card: dark on the left, picture on the right
  sc.fillStyle = linear(sc, 0, 0, PW, 0, [0, 'rgba(0,0,0,.9)', .3, 'rgba(0,0,0,.84)', .55, 'rgba(0,0,0,.3)', 1, 'rgba(0,0,0,0)']); sc.fillRect(0, 0, PW, PH);
  sc.fillStyle = linear(sc, 0, 0, 0, PH, [0, 'rgba(0,0,0,.35)', .3, 'rgba(0,0,0,0)', .7, 'rgba(0,0,0,0)', 1, 'rgba(0,0,0,.45)']); sc.fillRect(0, 0, PW, PH);
  const grain = [];
  for (let k = 0; k < 3; k++) {
    const c = mkCanvas(256, 256), g = c2d(c), img = g.createImageData(256, 256), d = img.data, r = rng(77 + k);
    for (let i = 0; i < d.length; i += 4) { d[i] = d[i + 1] = d[i + 2] = 118 + (r() * 21 | 0); d[i + 3] = 255; }
    g.putImageData(img, 0, 0); grain.push(mainCtx.createPattern(c, 'repeat'));
  }
  const glow = mkCanvas(64, 64), gc = c2d(glow);
  gc.fillStyle = radial(gc, 32, 32, 0, 32, [0, 'rgba(255,224,170,1)', .25, 'rgba(255,200,130,.55)', .6, 'rgba(255,170,100,.14)', 1, 'rgba(255,160,90,0)']); gc.fillRect(0, 0, 64, 64);
  return { vig, shade, grain, glow };
}

/* ======================================================================
   LOOK 1 — 'eclipse' (Чёрное солнце): eclipse over dunes → wide desert with a walking figure → title card
   ====================================================================== */
// Dune ridge in layer space: sharp crests (|sin|) plus a long swell; backlit rim stroke on top.
function dune(c, color, base, a1, f1, a2, f2, ph, rim) {
  c.beginPath(); c.moveTo(0, LH);
  for (let x = 0; x <= LW; x += 4) c.lineTo(x, base - a1 + a1 * Math.abs(Math.sin(x / f1 + ph)) + a2 * Math.sin(x / f2 + ph * 1.7));
  c.lineTo(LW, LH); c.closePath(); c.fillStyle = color; c.fill();
  c.beginPath();
  for (let x = 0; x <= LW; x += 4) { const y = base - a1 + a1 * Math.abs(Math.sin(x / f1 + ph)) + a2 * Math.sin(x / f2 + ph * 1.7); x ? c.lineTo(x, y) : c.moveTo(x, y); }
  c.lineWidth = 1.5; c.strokeStyle = rim; c.stroke();
}
function buildEclipse(m, r) {
  const [p0, p1, p2] = pal(m), L = { s1: ecl1, s2: ecl2, flip: false };
  // sky: deep night above, warm band where the dunes meet it (picture y ≈ 345 → layer fraction .61)
  const sky = mkCanvas(HW, HH), s = c2d(sky);
  s.fillStyle = linear(s, 0, 0, 0, HH, [0, p0, .42, p1, .57, '#6e2c2e', .63, '#c6683a', .7, '#4a1e26', 1, '#1a0c12']); s.fillRect(0, 0, HW, HH);
  s.fillStyle = '#fff'; for (let i = 0; i < 70; i++) { s.globalAlpha = .25 + r() * .5; s.fillRect(r() * HW, r() * HH * .45, 1, 1); } s.globalAlpha = 1;
  // corona glow (soft, half-res) and the black disc with its rim (sharp, small canvas)
  const corona = mkCanvas(HW, HH), cc = c2d(corona), ex = (830 - LX) / 2, ey = (250 - LY) / 2;
  cc.fillStyle = radial(cc, ex, ey, 30, 170, [0, 'rgba(255,185,105,.95)', .3, 'rgba(255,120,50,.4)', .6, 'rgba(255,90,40,.12)', 1, 'rgba(255,80,40,0)']); cc.fillRect(0, 0, HW, HH);
  const disc = mkCanvas(300, 300), dc = c2d(disc);
  dc.shadowBlur = 18; dc.shadowColor = 'rgba(255,200,120,.9)'; dc.lineWidth = 3; dc.strokeStyle = 'rgba(255,225,170,.9)';
  dc.beginPath(); dc.arc(150, 150, 118, 0, TAU); dc.stroke(); dc.stroke(); dc.shadowBlur = 0;
  dc.fillStyle = '#030205'; dc.beginPath(); dc.arc(150, 150, 118, 0, TAU); dc.fill();
  dc.lineWidth = 1.5; dc.strokeStyle = 'rgba(255,235,190,.95)'; dc.beginPath(); dc.arc(150, 150, 118.5, 0, TAU); dc.stroke();
  const flare = mkCanvas(900, 6), fc = c2d(flare);
  fc.fillStyle = linear(fc, 0, 0, 900, 0, [0, 'rgba(255,210,160,0)', .5, 'rgba(255,220,180,1)', 1, 'rgba(255,210,160,0)']); fc.fillRect(0, 0, 900, 6);
  // three dune ridges, far → near (lighter and hazier far away)
  const far = mkCanvas(LW, LH), mid = mkCanvas(LW, LH), near = mkCanvas(LW, LH);
  dune(c2d(far), '#1d1019', 368, 16, 95, 5, 31, 0.4, 'rgba(255,150,90,.35)');
  dune(c2d(mid), '#140b16', 418, 22, 140, 7, 41, 2.1, 'rgba(255,140,90,.2)');
  dune(c2d(near), '#0b0810', 473, 30, 210, 9, 57, 4.3, 'rgba(255,130,90,.12)');
  // wide shot: low sun with a haze band, and a flat sand plain
  const sun2 = mkCanvas(HW, HH), s2 = c2d(sun2), sx = (300 - LX) / 2, sy = (345 - LY) / 2;
  s2.fillStyle = linear(s2, 0, sy - 40, 0, sy + 40, [0, rgba(p2, 0), .5, rgba(p2, .35), 1, rgba(p2, 0)]); s2.fillRect(0, sy - 40, HW, 80);
  s2.fillStyle = radial(s2, sx, sy, 0, 150, [0, 'rgba(255,170,90,.9)', .25, 'rgba(255,110,50,.35)', 1, 'rgba(255,100,50,0)']); s2.fillRect(0, 0, HW, HH);
  s2.fillStyle = '#ffd2a0'; s2.beginPath(); s2.arc(sx, sy, 11, 0, TAU); s2.fill();
  const flat = mkCanvas(HW, HH), fl = c2d(flat), fy = (400 - LY) / 2;
  fl.fillStyle = linear(fl, 0, fy, 0, HH, [0, '#2a141a', .15, '#1a0c12', 1, '#070406']); fl.fillRect(0, fy, HW, HH - fy);
  fl.fillStyle = linear(fl, 0, fy, 0, fy + 10, [0, 'rgba(255,150,90,.25)', 1, 'rgba(255,150,90,0)']); fl.fillRect(0, fy, HW, 10);
  Object.assign(L, { sky, corona, disc, flare, far, mid, near, sun2, flat });
  L.sand = particles(70, r, (P, i, r) => { P[i] = r() * PW; P[i + 1] = 380 + r() * 170; P[i + 2] = -(18 + 22 * r()); P[i + 3] = 0; P[i + 4] = 1 + r(); P[i + 5] = r() * TAU; });
  L.dust = particles(90, r, (P, i, r) => { P[i] = r() * PW; P[i + 1] = 200 + r() * 352; P[i + 2] = -(25 + 40 * r()); P[i + 3] = -(2 + 4 * r()); P[i + 4] = 1 + r() * 1.2; P[i + 5] = r() * TAU; });
  L.wind = particles(6, r, (P, i, r) => { P[i] = r() * PW; P[i + 1] = 300 + r() * 200; P[i + 2] = -(110 + 60 * r()); P[i + 3] = 0; P[i + 4] = 1; P[i + 5] = r() * TAU; });
  return L;
}
// Shot 1 — slow push-in on the eclipse; corona breathes, anamorphic flare pulses, horizon shimmers.
function ecl1(L, u, t) {
  cam(1 + 0.12 * easeIO(u), 0);
  setA(1); layer(L.sky, .3, 0);
  setA(0.85 + 0.15 * Math.sin(t * 1.7)); layer(L.corona, .4, 0);
  const w = 900 * (0.9 + 0.1 * Math.sin(t * 2.3 + 1));
  setA(.22); ctx.drawImage(L.flare, 830 - w / 2, 247, w, 6);
  setA(1); ctx.drawImage(L.disc, 680, 100);
  layer(L.far, .3, 0); shimmer(L.far, .3, 0, 352, t);
  layer(L.mid, .6, 0); layer(L.near, 1, 0);
  motes(L.sand, t, '#f2c69a', .5, 0);
  uncam();
}
// Tiny backlit walker: head, torso, swinging legs and arms, a stretched shadow and a warm rim on the sun side.
function walker(x, y, t, sc) {
  const sw = Math.sin(t * 6) * 7 * sc;
  setA(.45); ctx.fillStyle = '#000'; ctx.beginPath(); ctx.ellipse(x + 10 * sc, y + 1, 18 * sc, 2.5 * sc, 0, 0, TAU); ctx.fill();
  setA(1); ctx.fillStyle = '#050306'; ctx.strokeStyle = '#050306'; ctx.lineCap = 'round';
  ctx.fillRect(x - 3 * sc, y - 30 * sc, 6 * sc, 16 * sc);
  ctx.beginPath(); ctx.arc(x, y - 34 * sc, 4 * sc, 0, TAU); ctx.fill();
  ctx.lineWidth = 2 * sc; ctx.beginPath(); ctx.moveTo(x - sc, y - 14 * sc); ctx.lineTo(x - sc + sw, y); ctx.moveTo(x + sc, y - 14 * sc); ctx.lineTo(x + sc - sw, y); ctx.stroke();
  ctx.lineWidth = 1.5 * sc; ctx.beginPath(); ctx.moveTo(x - 2 * sc, y - 28 * sc); ctx.lineTo(x - 2 * sc - sw * .7, y - 16 * sc); ctx.moveTo(x + 2 * sc, y - 28 * sc); ctx.lineTo(x + 2 * sc + sw * .7, y - 16 * sc); ctx.stroke();
  setA(.6); ctx.lineWidth = 1; ctx.strokeStyle = 'rgba(255,180,110,1)'; ctx.beginPath(); ctx.moveTo(x - 3 * sc, y - 30 * sc); ctx.lineTo(x - 3 * sc, y - 14 * sc); ctx.stroke();
}
// Shot 2 — wide horizon, slow pan, low sun, figure walking into the frame, wind streaks.
function ecl2(L, u, t) {
  const e = easeIO(u), tx = -90 * e;
  cam(1, 0);
  setA(1); layer(L.sky, .3, tx); layer(L.sun2, .35, tx);
  layer(L.far, .3, tx); shimmer(L.far, .3, tx, 352, t);
  layer(L.mid, .6, tx); layer(L.flat, .8, tx);
  walker(450 + 190 * u + tx, 455, t, 1.2);
  motes(L.dust, t, '#e8b890', .45, tx);
  ctx.fillStyle = '#f0c8a0';
  for (let i = 0; i < L.wind.length; i += 6) { setA(.12); ctx.fillRect(mod(L.wind[i] + L.wind[i + 2] * t, PW + 200) - 100 + tx, L.wind[i + 1], 120, 1); }
  uncam();
}

/* ======================================================================
   LOOK 2 — 'mountains' (Северный ветер): moonlit peaks with aurora → blizzard on the near ridge → title card
   ====================================================================== */
// Alpine profile in layer space: x → 0..1 height from a handful of triangular peaks plus fine noise.
function peakProfile(r, n, hwMin, hwMax) {
  const px = new Float32Array(n), pw = new Float32Array(n), ph = new Float32Array(n);
  for (let k = 0; k < n; k++) { px[k] = r() * LW; pw[k] = hwMin + r() * (hwMax - hwMin); ph[k] = .35 + .65 * r(); }
  return x => { let h = 0; for (let k = 0; k < n; k++) { const v = (1 - Math.abs(x - px[k]) / pw[k]) * ph[k]; if (v > h) h = v; } return h + .04 * Math.sin(x * .07) + .03 * Math.sin(x * .23); };
}
// Filled ridge with a moonlit rim above `snow` (0..1 of the profile) and optional fir silhouettes.
function ridge(c, color, base, amp, prof, rim, snow, trees, r, avoidX) {
  c.beginPath(); c.moveTo(0, LH);
  for (let x = 0; x <= LW; x += 3) c.lineTo(x, base - amp * prof(x));
  c.lineTo(LW, LH); c.closePath(); c.fillStyle = color; c.fill();
  c.lineWidth = 1.5; c.strokeStyle = rim; c.beginPath();
  let pen = false;
  for (let x = 0; x <= LW; x += 3) { const p = prof(x); if (p > snow) { pen ? c.lineTo(x, base - amp * p) : c.moveTo(x, base - amp * p); pen = true; } else pen = false; }
  c.stroke();
  if (!trees) return;
  c.fillStyle = color;
  for (let x = 0; x < LW; x += 8 + r() * 10) {
    if (Math.abs(x - avoidX) < 28) continue;
    const y = base - amp * prof(x), h = 8 + r() * 12, w = 3 + r() * 3;
    c.beginPath(); c.moveTo(x - w, y + 2); c.lineTo(x, y - h); c.lineTo(x + w, y + 2); c.closePath(); c.fill();
  }
}
function buildMountains(m, r) {
  const [p0, p1] = pal(m), L = { s1: mnt1, s2: mnt2, flip: true };
  const sky = mkCanvas(HW, HH), s = c2d(sky);
  s.fillStyle = linear(s, 0, 0, 0, HH, [0, '#03070e', .35, p0, .7, p1, .86, '#1e4a5e', 1, '#0d2130']); s.fillRect(0, 0, HW, HH);
  // stars and the moon (sharp, full-res)
  const stars = mkCanvas(LW, LH), st = c2d(stars), mx = 300 - LX, my = 150 - LY;
  st.fillStyle = '#fff';
  for (let i = 0; i < 180; i++) { st.globalAlpha = .4 + r() * .6; const sz = r() < .25 ? 2 : 1; st.fillRect(r() * LW, r() * LH * .65, sz, sz); }
  st.globalAlpha = 1;
  st.fillStyle = radial(st, mx, my, 40, 170, [0, 'rgba(220,240,255,.55)', .3, 'rgba(200,225,250,.22)', 1, 'rgba(180,210,240,0)']); st.fillRect(mx - 170, my - 170, 340, 340);
  st.fillStyle = radial(st, mx - 14, my - 16, 10, 56, [0, '#f6f9fc', .8, '#dbe6ee', 1, '#b9c9d6']); st.beginPath(); st.arc(mx, my, 52, 0, TAU); st.fill();
  st.fillStyle = 'rgba(0,0,0,.08)';
  for (let i = 0; i < 6; i++) { const a = r() * TAU, d = r() * 36; st.beginPath(); st.arc(mx + Math.cos(a) * d, my + Math.sin(a) * d, 4 + r() * 8, 0, TAU); st.fill(); }
  // three ridges; the near one carries a fir forest and a cabin spot
  const pf = peakProfile(r, 8, 90, 260), pm = peakProfile(r, 7, 120, 300), pn = peakProfile(r, 5, 300, 520);
  const far = mkCanvas(LW, LH), mid = mkCanvas(LW, LH), near = mkCanvas(LW, LH);
  const cabinX = 880, cabinXL = cabinX - LX, cabinY = 483 - 70 * pn(cabinXL) + LY;
  ridge(c2d(far), '#1d3a4c', 333, 120, pf, 'rgba(205,228,242,.4)', .5, false, r, -1e9);
  ridge(c2d(mid), '#122633', 413, 90, pm, 'rgba(170,200,220,.22)', .3, false, r, -1e9);
  ridge(c2d(near), '#0b1821', 483, 70, pn, 'rgba(140,175,200,.14)', 0, true, r, cabinXL);
  const cabin = mkCanvas(40, 30), cb = c2d(cabin);
  cb.fillStyle = radial(cb, 20, 25, 0, 16, [0, 'rgba(255,200,130,.35)', 1, 'rgba(255,200,130,0)']); cb.fillRect(0, 10, 40, 20);
  cb.fillStyle = '#07111a'; cb.fillRect(13, 15, 14, 9); cb.fillRect(24, 9, 2, 5);
  cb.fillStyle = '#0a1620'; cb.beginPath(); cb.moveTo(11, 15); cb.lineTo(20, 8); cb.lineTo(29, 15); cb.closePath(); cb.fill();
  cb.fillStyle = '#ffd9a0'; cb.fillRect(16, 18, 2, 3); cb.fillRect(22, 18, 2, 3);
  const fog = mkCanvas(HW, HH), fg = c2d(fog), fy = (380 - LY) / 2;
  fg.fillStyle = linear(fg, 0, fy, 0, fy + 90, [0, 'rgba(160,190,210,0)', .5, 'rgba(160,190,210,.4)', 1, 'rgba(160,190,210,0)']); fg.fillRect(0, fy, HW, 90);
  const curtain = mkCanvas(380, 400), cu = c2d(curtain);
  cu.fillStyle = linear(cu, 0, 0, 0, 400, [0, 'rgba(140,230,200,0)', .35, 'rgba(140,230,200,.22)', .7, 'rgba(120,200,230,.14)', 1, 'rgba(120,200,230,0)']); cu.fillRect(0, 0, 380, 400);
  cu.globalCompositeOperation = 'destination-in';
  cu.fillStyle = linear(cu, 0, 0, 380, 0, [0, 'rgba(0,0,0,0)', .3, 'rgba(0,0,0,1)', .7, 'rgba(0,0,0,1)', 1, 'rgba(0,0,0,0)']); cu.fillRect(0, 0, 380, 400);
  Object.assign(L, { sky, stars, far, mid, near, cabin, cabinX, cabinY, fog, curtain });
  L.aur = new Float32Array([520, 300, 380, 760, 380, 420, 1000, 260, 360]);
  L.twinkle = particles(24, r, (P, i, r) => { P[i] = r() * PW; P[i + 1] = r() * PH * .5; P[i + 2] = 0; P[i + 3] = 0; P[i + 4] = 1.5 + r(); P[i + 5] = r() * TAU; });
  L.snow = particles(130, r, (P, i, r) => { P[i] = r() * PW; P[i + 1] = r() * PH; P[i + 2] = -35; P[i + 3] = 55 + 25 * r(); P[i + 4] = 2 + r(); P[i + 5] = r() * TAU; });
  return L;
}
// Shot 1 — still night: twinkling stars, breathing aurora curtains, slow pan and a slight tilt up.
function mnt1(L, u, t) {
  const e = easeIO(u), tx = 60 * e;
  cam(1 + .02 * e, -12 * e);
  setA(1); layer(L.sky, .3, tx); layer(L.stars, .3, tx);
  ctx.fillStyle = '#fff';
  for (let i = 0, P = L.twinkle; i < P.length; i += 6) { setA(.3 + .7 * Math.abs(Math.sin(t * 3 + P[i + 5]))); ctx.fillRect(P[i] + tx * .3, P[i + 1], P[i + 4], P[i + 4]); }
  for (let i = 0, Q = L.aur; i < 3; i++) { setA(.55 + .45 * Math.sin(t * .37 + i * 1.9)); ctx.drawImage(L.curtain, Q[i * 3] + Math.sin(t * .5 + i * 2.1) * 60 + tx * .3, 20 + i * 10, Q[i * 3 + 1], Q[i * 3 + 2]); }
  setA(1); layer(L.far, .3, tx); layer(L.mid, .6, tx); layer(L.near, 1, tx);
  uncam();
}
// Shot 2 — closer on the near ridge in a blizzard: rising fog, a cabin with lit windows, wind-driven snow, white-out.
function mnt2(L, u, t) {
  const e = easeIO(u), gust = Math.sin(t * .7) * 20;
  cam(1.25 * (1 + .08 * e), -85);
  setA(1); layer(L.sky, .3, 0); layer(L.stars, .3, 0); layer(L.far, .3, 0); layer(L.mid, .6, 0);
  setA(.85); layer(L.fog, .6, 0, 30 - 60 * u);
  setA(1); layer(L.near, 1, 0);
  setA(.5 * (.9 + .1 * Math.sin(t * 3.1))); ctx.drawImage(S.glow, L.cabinX - 30, L.cabinY - 30, 60, 60);
  setA(1); ctx.drawImage(L.cabin, L.cabinX - 20, L.cabinY - 26);
  uncam();
  ctx.fillStyle = '#e9f1f7';
  for (let i = 0, P = L.snow, st = pstep(); i < P.length; i += st) {
    const x = mod(P[i] + (P[i + 2] + gust) * t, PW + 40) - 20, y = mod(P[i + 1] + P[i + 3] * t, PH + 40) - 20;
    setA(.75 * (.6 + .4 * Math.sin(t * 2 + P[i + 5]))); ctx.fillRect(x, y, P[i + 4], P[i + 4]);
  }
  setA(.06 + .03 * noise1d(t * 2)); ctx.fillStyle = '#c8d8e4'; ctx.fillRect(0, 0, PW, PH);
}

/* ======================================================================
   LOOK 3 — 'city' (Город на воде): sunset skyline over water → canal with bulbs and a gondola → title card
   ====================================================================== */
const HZ = 300; // horizon of the skyline shot (picture y)
// Silhouette skyline in layer space: boxes with domes, spires and stepped tops; optional lit windows.
function skyline(c, color, base, wMin, wMax, hMin, hMax, r, windows) {
  for (let x = 0; x < LW;) {
    const w = wMin + r() * (wMax - wMin), h = hMin + r() * (hMax - hMin), k = r();
    c.fillStyle = color; c.fillRect(x, base - h, w, h + 2);
    if (k < .12) { c.beginPath(); c.arc(x + w / 2, base - h, w * .45, Math.PI, TAU); c.fill(); c.fillRect(x + w / 2 - 1.5, base - h - w * .45 - 10, 3, 12); }
    else if (k < .3) c.fillRect(x + w / 2 - 1, base - h - 14 - r() * 20, 2, 36);
    else if (k < .45) c.fillRect(x + w * .2, base - h - 8, w * .6, 9);
    if (windows) {
      c.fillStyle = '#ffd9a0';
      for (let wy = base - h + 8; wy < base - 8; wy += 11) for (let wx = x + 5; wx < x + w - 6; wx += 9) if (r() < .35) { c.globalAlpha = .5 + r() * .5; c.fillRect(wx, wy, 3, 5); }
      c.globalAlpha = 1;
    }
    x += w + (r() < .3 ? 4 + r() * 10 : 0);
  }
}
// One canal façade between x0..x1 (layer space): plaster, cornices, water arches, arched window holes, mooring poles.
function facade(c, x0, x1, bottom, color, r, win) {
  c.fillStyle = color; c.fillRect(x0, 0, x1 - x0, bottom);
  c.fillStyle = 'rgba(0,0,0,.35)'; for (let y = bottom - 92; y > 20; y -= 95) c.fillRect(x0, y, x1 - x0, 3);
  c.fillStyle = 'rgba(255,200,150,.08)'; for (let y = bottom - 95; y > 20; y -= 95) c.fillRect(x0, y, x1 - x0, 1);
  c.fillStyle = '#07030a';
  for (let x = x0 + 24; x < x1 - 50; x += 72) { c.beginPath(); c.moveTo(x, bottom); c.lineTo(x, bottom - 40); c.arc(x + 20, bottom - 40, 20, Math.PI, TAU); c.lineTo(x + 40, bottom); c.closePath(); c.fill(); }
  for (let y = bottom - 150; y > 30; y -= 95) for (let x = x0 + 18; x < x1 - 32; x += 52) {
    c.fillStyle = '#0d0610'; c.fillRect(x, y, 14, 26); c.beginPath(); c.arc(x + 7, y, 7, Math.PI, TAU); c.fill();
    c.fillStyle = 'rgba(0,0,0,.4)'; c.fillRect(x - 4, y + 27, 22, 2);
    win.push(x + LX, y + LY, 14, 26, r() < .5 ? 1 : 0, r() * TAU);
  }
  const px = x0 === 0 ? x1 - 14 : x0 + 8;
  for (let i = 0; i < 3; i++) {
    const x = px + (x0 === 0 ? -i * 26 : i * 26), y = bottom + 6 + i * 12;
    c.fillStyle = '#1a0a12'; c.fillRect(x, y - 58, 6, 58);
    c.fillStyle = 'rgba(200,176,144,.5)'; for (let k = 0; k < 5; k++) c.fillRect(x, y - 58 + k * 12, 6, 6);
  }
}
function buildCity(m, r) {
  const [p0, p1, p2] = pal(m), L = { s1: cty1, s2: cty2, flip: false };
  const sky = mkCanvas(HW, HH), s = c2d(sky), hz = (HZ - LY) / 2, sunx = (940 - LX) / 2;
  s.fillStyle = linear(s, 0, 0, 0, HH, [0, p0, .25, '#3a1646', .42, p1, .5, '#b34a6c', hz / HH, p2, (hz + 8) / HH, '#8a3a58', 1, '#2a1136']); s.fillRect(0, 0, HW, HH);
  s.fillStyle = radial(s, sunx, hz, 0, 170, [0, 'rgba(255,217,160,.85)', .3, 'rgba(255,150,100,.3)', 1, 'rgba(255,140,100,0)']); s.fillRect(0, 0, HW, HH);
  s.fillStyle = '#ffd9a0'; s.beginPath(); s.arc(sunx, hz, 55, 0, TAU); s.fill();
  const skyFar = mkCanvas(LW, LH), skyNear = mkCanvas(LW, LH), nc = c2d(skyNear);
  skyline(c2d(skyFar), '#2a1536', HZ - LY, 20, 60, 20, 110, r, false);
  skyline(nc, '#160a1e', HZ - LY, 40, 120, 60, 180, r, true);
  nc.fillStyle = '#160a1e'; nc.fillRect(1180, HZ - LY - 250, 26, 252); nc.beginPath(); nc.moveTo(1176, HZ - LY - 250); nc.lineTo(1193, HZ - LY - 292); nc.lineTo(1210, HZ - LY - 250); nc.closePath(); nc.fill();
  nc.fillStyle = '#ffd9a0'; nc.globalAlpha = .8; nc.fillRect(1188, HZ - LY - 236, 3, 8); nc.fillRect(1195, HZ - LY - 236, 3, 8); nc.globalAlpha = 1;
  // open water: sky reflection fading to dark, a static sun path and soft window smears
  const water = mkCanvas(HW, HH), w = c2d(water);
  w.fillStyle = linear(w, 0, hz, 0, HH, [0, '#7a3a58', .08, '#4a1e46', .3, '#2a1136', 1, '#0e0616']); w.fillRect(0, hz, HW, HH - hz);
  w.fillStyle = '#ffd9a0';
  for (let i = 0; i < 60; i++) { w.globalAlpha = .05 + r() * .07; const y = hz + r() * (HH - hz), wd = 20 + (y - hz) * 1.6 * r(); w.fillRect(sunx - wd / 2 + (r() - .5) * 30, y, wd, 1); }
  for (let i = 0; i < 40; i++) { w.globalAlpha = .04 + r() * .05; w.fillRect(r() * HW, hz + r() * 40, 1.5, 6 + r() * 20); }
  w.globalAlpha = 1;
  // canal: two façades with a window list, water with reflections, a sagging bulb string
  const facades = mkCanvas(LW, LH), fc = c2d(facades), win = [], WL = 330 - LY;
  facade(fc, 0, 430 - LX, WL, '#2a1420', r, win);
  facade(fc, 900 - LX, LW, WL, '#1e1026', r, win);
  L.win = new Float32Array(win);
  const canalWater = mkCanvas(HW, HH), cw = c2d(canalWater), wl = WL / 2;
  cw.fillStyle = linear(cw, 0, wl, 0, HH, [0, '#3a1838', .1, '#1e0c24', 1, '#07030a']); cw.fillRect(0, wl, HW, HH - wl);
  cw.fillStyle = linear(cw, 0, wl, 0, HH, [0, rgba(p2, .4), .4, rgba(p1, .15), 1, rgba(p0, 0)]);
  cw.beginPath(); cw.moveTo((430 - LX) / 2, wl); cw.lineTo((900 - LX) / 2, wl); cw.lineTo((1000 - LX) / 2, HH); cw.lineTo((330 - LX) / 2, HH); cw.closePath(); cw.fill();
  cw.fillStyle = '#ffd9a0';
  for (let i = 0; i < win.length; i += 6) if (win[i + 4]) { cw.globalAlpha = .1; const x = (win[i] - LX) / 2 + 2, y = wl + (WL - (win[i + 1] - LY)) / 2; cw.fillRect(x, y, 3, 10 + r() * 24); }
  cw.globalAlpha = 1;
  const bulbs = new Float32Array(28);
  for (let i = 0; i < 14; i++) { const k = i / 13, a = (1 - k) * (1 - k), b = 2 * (1 - k) * k, c = k * k; bulbs[i * 2] = a * 436 + b * 664 + c * 894; bulbs[i * 2 + 1] = a * 118 + b * 232 + c * 118; }
  Object.assign(L, { sky, skyFar, skyNear, water, facades, canalWater, bulbs });
  L.lant = particles(18, r, (P, i, r) => { P[i] = r() * PW; P[i + 1] = r() * PH; P[i + 2] = 0; P[i + 3] = -14; P[i + 4] = 3 + r() * 2; P[i + 5] = r() * TAU; });
  L.spark = particles(40, r, (P, i, r) => { P[i] = r() * PW; P[i + 1] = 340 + r() * 212; P[i + 2] = -(4 + 6 * r()); P[i + 3] = 0; P[i + 4] = 1 + r(); P[i + 5] = r() * TAU; });
  return L;
}
// Shot 1 — sunset skyline over water with a shimmering sun path and lanterns drifting up; slow pan.
function cty1(L, u, t) {
  const e = easeIO(u), tx = -70 * e;
  cam(1, 0);
  setA(1); layer(L.sky, .3, tx); layer(L.skyFar, .45, tx); layer(L.skyNear, .7, tx); layer(L.water, .7, tx);
  ctx.fillStyle = '#ffc890';
  for (let i = 0, sx = 940 + tx * .3, st = quality === 'low' ? 2 : 1; i < 32; i += st) {
    const y = 312 + i * 7.4, w = 60 + (y - HZ) * 1.4;
    setA(.45 * (1 - i / 44) * (.7 + .3 * Math.sin(t * 3.1 + i * 2.3))); ctx.fillRect(sx + Math.sin(t * 2.3 + i * 1.7) * 12 - w / 2, y, w, 2);
  }
  for (let i = 0, P = L.lant; i < P.length; i += 6) {
    const x = P[i] + Math.sin(t * .8 + P[i + 5]) * 10 + tx, y = mod(P[i + 1] + P[i + 3] * t, PH + 60) - 30, sz = P[i + 4];
    setA(.6); ctx.drawImage(S.glow, x - sz * 4.5, y - sz * 4.5, sz * 9, sz * 9);
    setA(1); ctx.fillStyle = '#ffe0a0'; ctx.fillRect(x - sz * .4, y - sz * .5, sz * .8, sz);
  }
  uncam();
}
// Gondola silhouette with gondolier and oar; a < 1 draws the mirrored reflection.
function gondola(x, y, t, a) {
  setA(a); ctx.fillStyle = '#07030a'; ctx.strokeStyle = '#07030a'; ctx.lineCap = 'round';
  ctx.beginPath(); ctx.moveTo(x - 70, y - 14); ctx.lineTo(x - 62, y - 4); ctx.quadraticCurveTo(x, y + 16, x + 62, y - 4); ctx.lineTo(x + 72, y - 20); ctx.lineTo(x + 66, y - 8); ctx.lineTo(x - 60, y - 8); ctx.closePath(); ctx.fill();
  ctx.fillRect(x - 43, y - 28, 6, 20); ctx.beginPath(); ctx.arc(x - 40, y - 32, 3.5, 0, TAU); ctx.fill();
  ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(x - 38, y - 24 + Math.sin(t * 1.5) * 2); ctx.lineTo(x - 18, y + 2); ctx.stroke();
  setA(a * .15); ctx.strokeStyle = '#fff'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(x - 66, y); ctx.lineTo(x - 150, y + 7); ctx.moveTo(x - 66, y); ctx.lineTo(x - 150, y - 6); ctx.stroke();
}
// Shot 2 — the canal: blinking windows, a swaying bulb string, a gondola gliding through with its reflection.
function cty2(L, u, t) {
  cam(1 + .08 * easeIO(u), 0);
  setA(1); layer(L.sky, .2, 0); layer(L.skyFar, .3, 0); layer(L.skyNear, .4, 0); layer(L.canalWater, 1, 0); layer(L.facades, 1, 0);
  ctx.fillStyle = '#ffd9a0';
  for (let i = 0, W = L.win, slot = (t * 2) | 0; i < W.length; i += 6) {
    if ((W[i + 4] > .5) === (hash(slot * 131 + i) < .1)) continue;
    setA(.55 + .45 * hash(i * 7 + slot)); ctx.fillRect(W[i], W[i + 1], W[i + 2], W[i + 3]); ctx.beginPath(); ctx.arc(W[i] + 7, W[i + 1], 7, Math.PI, TAU); ctx.fill();
  }
  const B = L.bulbs;
  setA(1); ctx.strokeStyle = 'rgba(0,0,0,.55)'; ctx.lineWidth = 1; ctx.beginPath();
  for (let i = 0; i < 14; i++) { const x = B[i * 2], y = B[i * 2 + 1] + Math.sin(t * 1.1 + i * .4) * 2; i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }
  ctx.stroke();
  for (let i = 0; i < 14; i++) {
    const x = B[i * 2], y = B[i * 2 + 1] + Math.sin(t * 1.1 + i * .4) * 2 + 3;
    setA(.8 * (.9 + .1 * Math.sin(t * 5 + i))); ctx.drawImage(S.glow, x - 13, y - 13, 26, 26);
    setA(1); ctx.fillStyle = '#fff0c8'; ctx.fillRect(x - 1.5, y - 1.5, 3, 3);
  }
  const gx = 200 + 800 * u, gy = 430 + Math.sin(t * 1.5) * 1.5;
  ctx.save(); ctx.translate(0, 2 * gy + 4); ctx.scale(1, -1); gondola(gx, gy, t, .3); ctx.restore();
  gondola(gx, gy, t, 1);
  motes(L.spark, t, '#ffe6c0', .5, 0);
  uncam();
}

/* ======================================================================
   KEY-ART / TITLE CARD (shot 3 of every movie)
   ====================================================================== */
const fontsNow = () => fontOk('800 72px "Inter"') && fontOk('600 16px "Inter"');
// Text strips rendered once per movie: eyebrow, title (1–2 lines, warm halo), rule + caption, premiere label.
function buildStrips(m) {
  heavy = true;
  const sp = 84 * .14, left = 120;
  const tc = mkCanvas(PW, 240), c = c2d(tc);
  c.font = `800 80px ${F_TITLE}`; c.textBaseline = 'alphabetic';
  const title = String(m.title || '').toUpperCase(); let lines = [title];
  if (spacedWidth(c, title, sp) > 760) {
    let best = -1, bd = 1e9;
    for (let i = 0; i < title.length; i++) if (title[i] === ' ') { const d = Math.abs(i - title.length / 2); if (d <= bd) { bd = d; best = i; } }
    if (best > 0) lines = [title.slice(0, best), title.slice(best + 1)];
  }
  c.fillStyle = '#f6e9c6'; c.shadowBlur = 26; c.shadowColor = rgba(pal(m)[2], .55);
  for (let i = 0; i < lines.length; i++) spacedText(c, lines[i], left, 92 + i * 94, sp, 'left');
  c.shadowBlur = 0;
  const ec = mkCanvas(PW, 40), e = c2d(ec);
  e.font = `600 15px ${F_UI}`; e.fillStyle = 'rgba(244,231,195,.6)'; spacedText(e, 'ОРБИТА GRAND CINEMA СУНУШТАЙТ', left, 28, 15 * .28, 'left');
  const cc = mkCanvas(PW, 60), k = c2d(cc);
  k.fillStyle = 'rgba(216,178,87,.7)'; k.fillRect(left, 2, 180, 1);
  k.font = `500 19px ${F_UI}`; k.fillStyle = 'rgba(244,231,195,.78)';
  spacedText(k, `${String(m.genre || '').toUpperCase()}  ·  ${m.dur || ''}  ·  ${m.age || ''}`, left, 42, 19 * .2, 'left');
  const pc = mkCanvas(460, 30), p = c2d(pc), d = new Date();
  p.font = `500 14px ${F_UI}`; p.fillStyle = 'rgba(244,231,195,.5)';
  spacedText(p, 'ПРЕМЬЕРА · ' + ['ЯНВАРЬ', 'ФЕВРАЛЬ', 'МАРТ', 'АПРЕЛЬ', 'МАЙ', 'ИЮНЬ', 'ИЮЛЬ', 'АВГУСТ', 'СЕНТЯБРЬ', 'ОКТЯБРЬ', 'НОЯБРЬ', 'ДЕКАБРЬ'][d.getMonth()] + ' ' + d.getFullYear(), 450, 20, 14 * .2, 'right');
  return { title: tc, eyebrow: ec, caption: cc, prem: pc, titleY: 170, capY: lines.length > 1 ? 384 : 290, fontsOk: fontsNow() };
}
function card(L, m, u, t) {
  const tau = u * (LOOP - S2 + XF), A0 = A;
  A = A0 * .45;                                   // shot 1 sits dim behind the type (mirrored when its subject is on the left)
  if (L.flip) { ctx.save(); ctx.translate(PW, 0); ctx.scale(-1, 1); L.s1(L, .5, t); ctx.restore(); } else L.s1(L, .5, t);
  A = A0; setA(1); ctx.drawImage(S.shade, 0, 0);
  let st = L.strips; if (!st || (!st.fontsOk && fontsNow())) st = L.strips = buildStrips(m);
  setA(smooth(0, .6, tau)); ctx.drawImage(st.eyebrow, 0, 122);
  if (tau > .3) { const k = easeOut(clamp((tau - .3) / .9, 0, 1)), sc = 1.035 - .035 * k; setA(k); ctx.save(); ctx.translate(120, st.titleY + 120); ctx.scale(sc, sc); ctx.drawImage(st.title, -120, -120); ctx.restore(); }
  if (tau > .8) { setA(smooth(.8, 1.3, tau)); ctx.drawImage(st.caption, 0, st.capY); }
  if (tau > 1.2) { setA(smooth(1.2, 1.8, tau)); ctx.drawImage(st.prem, PW - 510, PH - 44); }
}

/* ======================================================================
   createScreen — texture, timeline, filmic pass, brightness, clock
   ====================================================================== */
export function createScreen({ THREE } = {}) {
  const T = THREE || THREE_;
  const canvas = mkCanvas(TW, TH); ctx = canvas.getContext('2d');
  const texture = new T.CanvasTexture(canvas);
  texture.colorSpace = T.SRGBColorSpace; texture.generateMipmaps = false; texture.minFilter = T.LinearFilter; texture.magFilter = T.LinearFilter;
  const clockCanvas = mkCanvas(256, 256), kctx = c2d(clockCanvas), dial = mkCanvas(256, 256);
  const clockTexture = new T.CanvasTexture(clockCanvas); clockTexture.colorSpace = T.SRGBColorSpace;
  const samp = mkCanvas(16, 9), sctx = samp.getContext('2d', { willReadFrequently: true });
  const LUT = new Float32Array(256); for (let i = 0; i < 256; i++) LUT[i] = Math.pow(i / 255, 2.2);
  const avgColor = new T.Color(0.25, 0.22, 0.2);
  const cache = new Map();
  const stills = new Map();
  const stillImg = (src) => { let im = stills.get(src); if (!im) { im = new Image(); im.decoding = 'async'; im.src = src; stills.set(src, im); } return im; };
  let bright = 0.3, curId = null, switchT = -1, lastDrawMs = 0, avgMs = 0, qualityLocked = false, dialDirty = true, lastClock = '';
  S = buildShared(ctx);

  function getLook(m) {
    let L = cache.get(m.id);
    if (!L) { heavy = true; const r = rng(strHash(String(m.id))); L = m.type === 'mountains' ? buildMountains(m, r) : m.type === 'city' ? buildCity(m, r) : buildEclipse(m, r); cache.set(m.id, L); }
    return L;
  }

  // Vignette, animated grain, projector flicker, a rare scratch, loop-seam and movie-switch dips to black.
  function filmic(t, timeSec) {
    ctx.globalAlpha = 1; ctx.drawImage(S.vig, 0, 0);
    const ox = hash(frame * 7 + 1) * 256 | 0, oy = hash(frame * 7 + 2) * 256 | 0, hi = quality === 'high';
    ctx.globalCompositeOperation = hi ? 'overlay' : 'source-over'; ctx.globalAlpha = hi ? .07 : .045;
    ctx.fillStyle = S.grain[frame % 3]; ctx.translate(ox, oy); ctx.fillRect(-ox, -oy, PW, PH); ctx.translate(-ox, -oy);
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = '#000'; ctx.globalAlpha = .02 + .02 * noise1d(t * 23); ctx.fillRect(0, 0, PW, PH);
    const slot = (t * 24) | 0;
    if (hash(slot + 9001) < .015) { ctx.fillStyle = '#fff'; ctx.globalAlpha = .08; ctx.fillRect(hash(slot + 7001) * PW | 0, 0, 1, PH); }
    const seam = t < DIP ? t / DIP : t > LOOP - DIP ? (LOOP - t) / DIP : 1;
    const sw = switchT < 0 ? 1 : smooth(0, SWITCH, timeSec - switchT);
    const dark = 1 - Math.min(seam, sw);
    if (dark > .002) { ctx.fillStyle = '#000'; ctx.globalAlpha = dark; ctx.fillRect(0, 0, PW, PH); }
    ctx.globalAlpha = 1;
  }

  // Mean linearised luminance (and colour) of a 16×9 downsample (4×/s), smoothed so the hall light never pops.
  function sample() {
    sctx.drawImage(canvas, 0, 0, 16, 9);
    const d = sctx.getImageData(0, 0, 16, 9).data, n = d.length / 4;
    let r = 0, g = 0, b = 0, lum = 0;
    for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2]; lum += LUT[d[i]] * .2126 + LUT[d[i + 1]] * .7152 + LUT[d[i + 2]] * .0722; }
    const target = clamp(Math.pow(lum / n, .6), .06, 1);
    bright += (target - bright) * .25;
    avgColor.setRGB(r / n / 255, g / n / 255, b / n / 255, T.SRGBColorSpace);
  }

  function draw(movie, timeSec) {
    if (!movie) return;
    heavy = false;
    const t0 = performance.now(), L = getLook(movie);
    if (movie.id !== curId) { if (curId !== null) switchT = timeSec; curId = movie.id; }
    const t = mod(timeSec || 0, LOOP);
    frame++;
    // A film with a landscape poster shows it full-frame with a slow push-in, then the usual fade on switch.
    if (movie.still) {
      const img = stillImg(movie.still);
      if (img.complete && img.naturalWidth) {
        ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = 1;
        const z = 1.02 + 0.05 * (0.5 - 0.5 * Math.cos(t / LOOP * TAU)), w = TW * z, h = TH * z;
        ctx.drawImage(img, (TW - w) / 2, (TH - h) / 2, w, h);
        const sw = switchT < 0 ? 1 : smooth(0, SWITCH, (timeSec || 0) - switchT);
        if (sw < 1) { ctx.fillStyle = '#000'; ctx.globalAlpha = 1 - sw; ctx.fillRect(0, 0, TW, TH); ctx.globalAlpha = 1; }
        texture.needsUpdate = true;
        if (frame % 6 === 0) sample();
        return;
      }
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = 1;
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, TW, TH);
    ctx.save();
    ctx.setTransform(TW / VW, 0, 0, 1, 0, BAR);                 // anamorphic squeeze: virtual PW×PH → 1024×552 inside the bars
    ctx.beginPath(); ctx.rect(0, 0, PW, PH); ctx.clip();
    ctx.translate(Math.sin(t * 1.3) * .7, Math.cos(t * .9) * .5); // gate weave
    A = 1;
    if (t < S1) L.s1(L, t / S1, t);
    if (t >= S1 - XF && t < S2) { A = t < S1 ? smooth(S1 - XF, S1, t) : 1; L.s2(L, (t - S1 + XF) / (S2 - S1 + XF), t); }
    if (t >= S2 - XF) { A = t < S2 ? smooth(S2 - XF, S2, t) : 1; card(L, movie, (t - S2 + XF) / (LOOP - S2 + XF), t); }
    A = 1;
    filmic(t, timeSec || 0);
    ctx.restore();
    texture.needsUpdate = true;
    lastDrawMs = performance.now() - t0;
    if (!heavy) { avgMs += (lastDrawMs - avgMs) * .033; if (!qualityLocked && quality === 'high' && avgMs > 2.4 && frame > 90) quality = 'low'; }
    if (frame % 6 === 0) sample();
  }

  function buildDial() {
    const d = c2d(dial), cx = 128, cy = 128; d.clearRect(0, 0, 256, 256);
    d.fillStyle = radial(d, cx, cy, 10, 126, [0, '#17151b', 1, '#0a090d']); d.beginPath(); d.arc(cx, cy, 126, 0, TAU); d.fill();
    d.fillStyle = linear(d, 40, 30, 216, 226, [0, '#e8cc84', .5, '#a8853f', 1, '#e8cc84']);
    d.beginPath(); d.arc(cx, cy, 120, 0, TAU); d.arc(cx, cy, 112, 0, TAU, true); d.fill();
    d.lineWidth = 1; d.strokeStyle = 'rgba(0,0,0,.6)';
    d.beginPath(); d.arc(cx, cy, 120.5, 0, TAU); d.stroke(); d.beginPath(); d.arc(cx, cy, 111.5, 0, TAU); d.stroke();
    d.strokeStyle = 'rgba(201,166,84,.45)'; d.beginPath(); d.arc(cx, cy, 102, 0, TAU); d.stroke();
    d.fillStyle = '#c9a654';
    for (let i = 0; i < 60; i++) {
      const a = i / 60 * TAU - Math.PI / 2, ca = Math.cos(a), sa = Math.sin(a);
      if (i % 5 === 0) { const major = i % 15 === 0, len = major ? 13 : 8, w = major ? 3 : 1.5; d.save(); d.translate(cx + ca * 108, cy + sa * 108); d.rotate(a); d.fillRect(-len, -w / 2, len, w); d.restore(); }
      else { d.globalAlpha = .25; d.beginPath(); d.arc(cx + ca * 106, cy + sa * 106, 1, 0, TAU); d.fill(); d.globalAlpha = 1; }
    }
    d.globalAlpha = .06; d.fillStyle = '#fff'; d.beginPath(); d.ellipse(cx - 30, cy - 45, 70, 40, -.6, 0, TAU); d.fill();
    d.globalAlpha = .45; d.fillStyle = '#e8cc84'; d.font = `700 9px ${F_UI}`; d.textBaseline = 'alphabetic'; spacedText(d, 'ОРБИТА', cx, 84, 9 * .3, 'center');
    d.globalAlpha = 1; dialDirty = false;
  }
  function drawClock(timeStr) {
    if (dialDirty) buildDial();
    lastClock = timeStr == null ? '' : String(timeStr);
    kctx.clearRect(0, 0, 256, 256); kctx.drawImage(dial, 0, 0);
    if (lastClock) {
      kctx.textBaseline = 'alphabetic'; kctx.font = `700 60px ${F_UI}`; kctx.fillStyle = '#f6dfa0'; kctx.shadowBlur = 14; kctx.shadowColor = 'rgba(255,200,110,.55)';
      spacedText(kctx, lastClock, 128, 146, 60 * .02, 'center'); kctx.shadowBlur = 0;
      kctx.font = `700 13px ${F_UI}`; kctx.fillStyle = 'rgba(240,207,122,.7)'; spacedText(kctx, 'СЕАНС', 128, 178, 13 * .35, 'center');
    }
    clockTexture.needsUpdate = true;
  }
  drawClock('');
  // Web fonts usually arrive after the first frames: rebuild every text strip and the dial once they are in.
  if (typeof document !== 'undefined' && document.fonts && document.fonts.ready) {
    document.fonts.ready.then(() => { cache.forEach(L => { L.strips = null; }); dialDirty = true; drawClock(lastClock); }).catch(() => {});
  }

  function prewarm(movie) { if (movie) { const L = getLook(movie); if (!L.strips) L.strips = buildStrips(movie); } }
  function setScreenAspect(w, h) {
    VW = Math.round(TW * (w / h) / (16 / 9)); PW = Math.min(VW, LW - 160); LX = -(LW - PW) / 2;
    S = buildShared(ctx); cache.forEach(L => { L.strips = null; });
  }
  function setQuality(q) { quality = q === 'low' ? 'low' : 'high'; qualityLocked = true; }
  function dispose() { cache.clear(); texture.dispose(); clockTexture.dispose(); }

  return {
    texture, clockTexture, draw, drawClock, brightness: () => bright,
    canvas, clockCanvas, avgColor, LOOP, prewarm, setScreenAspect, setQuality, dispose,
    get lastDrawMs() { return lastDrawMs; }, get quality() { return quality; },
  };
}

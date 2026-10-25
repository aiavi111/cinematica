/**
 * hall.js — auditorium architecture and light rig for the «Орбита» cinema prototype.
 *
 *   export function buildHall({ THREE, scene, M }) → hall
 *
 * Geometry is merged per material into ~25 draw calls. Every surface that the outside
 * overview camera looks through (back wall, ceiling, back-wall fittings) is a
 * single-sided plane whose normal points INTO the hall, so nothing shows from outside.
 * UVs on large surfaces are in metres (1 uv unit = 1 m); materials.js sets the repeat.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

const PI = Math.PI;
const ROWS = 10, ROW_DEPTH = 1.15, ROW_RISE = 0.28, FIRST_ROW_Z = -4.2;
const rowZ = (r) => FIRST_ROW_Z + r * ROW_DEPTH;
const rowY = (r) => r * ROW_RISE;
const TIER0_FRONT = rowZ(0) - ROW_DEPTH / 2;        // -4.775
const LANDING_Z = rowZ(ROWS - 1) + ROW_DEPTH / 2;   //  6.725
const LANDING_Y = rowY(ROWS - 1);
const floorAt = (z) => (z < rowZ(0) - ROW_DEPTH / 2 ? 0 : rowY(Math.min(ROWS - 1, Math.max(0, Math.round((z - FIRST_ROW_Z) / ROW_DEPTH)))));                   //  2.52
const SCREEN_C = Object.freeze([0, 3.5, -10.95]);
const SCREEN_LIGHT_BASE = 36;
const SCONCE_BASE = 5.5;
const SCONCE_I = SCONCE_BASE * 1.3;

/** Hall constants other modules may want (metres, Y up). */
export const HALL_DIMS = Object.freeze({
  xMin: -8, xMax: 8, ceilingY: 7.6, zFront: -11.5, zBack: 8.5,
  stageTopY: 0.5, stageFrontZ: -8.3,
  screenW: 12, screenH: 5.2, screenCenter: SCREEN_C,
  rows: ROWS, rowDepth: ROW_DEPTH, rowRise: ROW_RISE, firstRowZ: FIRST_ROW_Z,
  landingY: LANDING_Y, landingZ: LANDING_Z,
});

/* ------------------------------------------------------------------ materials */

function resolveMaterials(M) {
  const std = (p) => new THREE.MeshStandardMaterial(p);
  const glow = (hex, k) => { const m = new THREE.MeshBasicMaterial({ color: hex }); m.color.multiplyScalar(k); return m; };
  const pick = (key, make) => (M[key] && M[key].isMaterial ? M[key] : make());
  return {
    carpet:        pick('carpet',        () => std({ color: 0x16121a, roughness: 1 })),
    carpetAisle:   pick('carpetAisle',   () => std({ color: 0x1a1420, roughness: 1 })),
    wallPanel:     pick('wallPanel',     () => std({ color: 0x231d25, roughness: 0.95 })),
    wallDark:      pick('wallDark',      () => std({ color: 0x141216, roughness: 0.95 })),
    ceiling:       pick('ceiling',       () => std({ color: 0x0f0e11, roughness: 1 })),
    wood:          pick('wood',          () => std({ color: 0x2a1f1b, roughness: 0.45, metalness: 0.05 })),
    brass:         pick('brass',         () => std({ color: 0xc9a654, metalness: 0.9, roughness: 0.3 })),
    blackMetal:    pick('blackMetal',    () => std({ color: 0x0c0c0f, roughness: 0.5, metalness: 0.4 })),
    curtain:       pick('curtain',       () => std({ color: 0x6a1320, roughness: 1, side: THREE.DoubleSide })),
    screenFrame:   pick('screenFrame',   () => std({ color: 0x070708, roughness: 0.9 })),
    emissiveWarm:  pick('emissiveWarm',  () => glow(0xffe4bf, 1.8)),
    emissiveBrass: pick('emissiveBrass', () => glow(0xf0cf7a, 1.6)),
    exitGreen:     pick('exitGreen',     () => glow(0x3cff8a, 1.4)),
    trim:          std({ color: 0x2b1c14, roughness: 0.5, metalness: 0, envMapIntensity: 0.8 }),
  };
}

/** Bright colour for the exit-sign decal, taken from M.exitGreen whatever its type. */
function exitColor(mat) {
  let c = mat.color && (mat.color.r + mat.color.g + mat.color.b) > 0.3 ? mat.color : mat.emissive;
  c = c ? c.clone() : new THREE.Color(0x3cff8a);
  const mx = Math.max(c.r, c.g, c.b, 1e-3);
  if (mx < 1.2) c.multiplyScalar(1.4 / mx);
  return c;
}

/* ------------------------------------------------------------------ procedural decals */

function canvasTexture(w, h, paint) {
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');
  paint(ctx, w, h);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.userData.repaint = () => { ctx.clearRect(0, 0, w, h); paint(ctx, w, h); tex.needsUpdate = true; };
  return tex;
}

const paintSlitHalo = (ctx, w, h) => {
  const g = ctx.createLinearGradient(0, 0, w, 0);
  g.addColorStop(0, 'rgba(255,255,255,0)');
  g.addColorStop(0.25, 'rgba(255,255,255,0.18)');
  g.addColorStop(0.5, 'rgba(255,255,255,1)');
  g.addColorStop(0.75, 'rgba(255,255,255,0.18)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
};

const paintScallop = (ctx, w, h) => {         // elongated up/down wash of a wall sconce
  ctx.save(); ctx.translate(w / 2, h / 2); ctx.scale(1, h / w);
  const g = ctx.createRadialGradient(0, 0, 0, 0, 0, w / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.22, 'rgba(255,255,255,0.55)');
  g.addColorStop(0.6, 'rgba(255,255,255,0.14)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g; ctx.fillRect(-w / 2, -w / 2, w, w); ctx.restore();
};

const paintEdgeGrad = (ctx, w, h) => {        // bright at the right edge, fading left (rotated per side)
  const g = ctx.createLinearGradient(0, 0, w, 0);
  g.addColorStop(0, 'rgba(255,255,255,0)');
  g.addColorStop(0.6, 'rgba(255,255,255,0.25)');
  g.addColorStop(1, 'rgba(255,255,255,1)');
  ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
};

const paintTopGrad = (ctx, w, h) => {         // bright at the top, fading down
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.35, 'rgba(255,255,255,0.32)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
};

const paintGlint = (ctx, w, h) => {           // bright core + long horizontal anamorphic streak + short vertical spike
  const cx = w / 2, cy = h / 2;
  let g = ctx.createRadialGradient(cx, cy, 0, cx, cy, h / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(0.18, 'rgba(255,255,255,0.55)'); g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g; ctx.fillRect(cx - h / 2, 0, h, h);
  g = ctx.createLinearGradient(0, 0, w, 0);
  g.addColorStop(0, 'rgba(255,255,255,0)'); g.addColorStop(0.5, 'rgba(255,255,255,0.9)'); g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g; ctx.fillRect(0, cy - 1.5, w, 3);
  ctx.globalAlpha = 0.25; ctx.fillRect(w * 0.15, cy - 5, w * 0.7, 10); ctx.globalAlpha = 1;
  g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, 'rgba(255,255,255,0)'); g.addColorStop(0.5, 'rgba(255,255,255,0.7)'); g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g; ctx.fillRect(cx - 1, 0, 2, h);
};

const paintExitSign = (ctx, w, h) => {
  ctx.strokeStyle = '#fff'; ctx.lineWidth = 4;
  ctx.strokeRect(4, 4, w - 8, h - 8);
  ctx.fillStyle = '#fff';
  ctx.beginPath(); ctx.moveTo(22, h / 2); ctx.lineTo(50, h / 2 - 17); ctx.lineTo(50, h / 2 + 17); ctx.closePath(); ctx.fill();
  ctx.font = '700 42px "Inter", system-ui, -apple-system, "Segoe UI", sans-serif';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText('ЧЫГУУ', w * 0.6, h / 2 + 2);
};

/* ------------------------------------------------------------------ builder */

export function buildHall({ scene, M = {} }) {
  const mats = resolveMaterials(M);
  const root = new THREE.Group();
  root.name = 'hall';

  // reusable transform scratch
  const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _e = new THREE.Euler();
  const _p = new THREE.Vector3(), _s = new THREE.Vector3();
  const place = (g, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0) => {
    _e.set(rx, ry, rz); _q.setFromEuler(_e); _p.set(x, y, z); _s.set(1, 1, 1);
    _m.compose(_p, _q, _s); g.applyMatrix4(_m); return g;
  };
  const setInst = (mesh, i, x, y, z, sx = 1, sy = 1, sz = 1, rx = 0, ry = 0, rz = 0) => {
    _e.set(rx, ry, rz); _q.setFromEuler(_e); _p.set(x, y, z); _s.set(sx, sy, sz);
    _m.compose(_p, _q, _s); mesh.setMatrixAt(i, _m);
  };
  const uvScale = (g, su, sv) => {
    const a = g.attributes.uv;
    for (let i = 0; i < a.count; i++) a.setXY(i, a.getX(i) * su, a.getY(i) * sv);
    return g;
  };
  const box = (w, h, d) => new THREE.BoxGeometry(w, h, d);
  const plane = (w, h) => new THREE.PlaneGeometry(w, h);

  // geometry buckets → one merged Mesh per material
  const BUCKETS = {
    carpet:        { mat: mats.carpet,        recv: true },
    carpetAisle:   { mat: mats.carpetAisle,   recv: true },
    wallDark:      { mat: mats.wallDark,      recv: true },
    wallPanel:     { mat: mats.wallPanel,     recv: true },
    panelR:        { mat: mats.wallPanel,     recv: true },               // rounded fabric panels (non-indexed)
    trim:          { mat: mats.trim,          recv: true },
    ceiling:       { mat: mats.ceiling },
    wood:          { mat: mats.wood,          recv: true },
    brass:         { mat: mats.brass,         recv: true },
    blackMetal:    { mat: mats.blackMetal,    recv: true },               // booth frame, sign backings
    speakers:      { mat: mats.blackMetal,    recv: true, cast: true },   // RoundedBox is non-indexed → own bucket
    blackTrim:     { mat: mats.blackMetal },                              // ceiling rings (no shadow)
    screenFrame:   { mat: mats.screenFrame,   recv: true, cast: true },   // masking, pelmets
    screenWall:    { mat: mats.screenFrame,   recv: true },               // black surround (no shadow)
    emissiveWarm:  { mat: mats.emissiveWarm },
    emissiveBrass: { mat: mats.emissiveBrass },
  };
  const B = {};
  const put = (key, g, x, y, z, rx, ry, rz) => { (B[key] || (B[key] = [])).push(place(g, x, y, z, rx, ry, rz)); return g; };

  /* ---------- 1. floor, tiers, aisle runners ---------- */

  // Stepped carpet profile for x∈[x0,x1], z∈[z0,z1]: flat front, 10 tiers with risers, back landing.
  function steppedFloor(x0, x1, z0, z1, lift = 0) {
    const pos = [], nrm = [], uv = [], idx = [];
    const quad = (a, b, c, d, nx, ny, nz) => {
      const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
      const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
      const flip = (uy * vz - uz * vy) * nx + (uz * vx - ux * vz) * ny + (ux * vy - uy * vx) * nz < 0;
      const pts = flip ? [a, d, c, b] : [a, b, c, d];
      const base = pos.length / 3;
      for (const p of pts) { pos.push(p[0], p[1] + lift, p[2]); nrm.push(nx, ny, nz); uv.push(p[0], ny ? p[2] : p[1]); }
      idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    };
    const flat = (y, za, zb) => { if (zb - za > 1e-4) quad([x0, y, za], [x0, y, zb], [x1, y, zb], [x1, y, za], 0, 1, 0); };
    flat(0, z0, Math.min(z1, TIER0_FRONT));
    for (let r = 0; r < ROWS; r++) {
      const zf = rowZ(r) - ROW_DEPTH / 2, zb = rowZ(r) + ROW_DEPTH / 2;
      if (r > 0 && zf >= z0 && zf <= z1) { const zr = zf - lift; quad([x1, rowY(r - 1), zr], [x0, rowY(r - 1), zr], [x0, rowY(r), zr], [x1, rowY(r), zr], 0, 0, -1); }
      flat(rowY(r), Math.max(z0, zf), Math.min(z1, zb));
    }
    flat(LANDING_Y, Math.max(z0, LANDING_Z), z1);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idx);
    return g;
  }

  put('carpet', steppedFloor(-8, 8, -8.3, 8.5));
  put('carpetAisle', steppedFloor(-3.0, -1.8, -4.8, LANDING_Z, 0.006));   // left aisle runner
  put('carpetAisle', steppedFloor(1.8, 3.0, -4.8, LANDING_Z, 0.006));     // right aisle runner
  put('carpetAisle', steppedFloor(-7.95, -6.68, -4.8, LANDING_Z, 0.006)); // left wall aisle
  put('carpetAisle', steppedFloor(6.68, 7.95, -4.8, LANDING_Z, 0.006));   // right wall aisle
  put('carpetAisle', steppedFloor(-8, 8, -5.8, -4.8, 0.006));             // front cross-aisle
  put('carpetAisle', steppedFloor(-8, 8, LANDING_Z, 8.5, 0.006));         // back landing walkway

  // Lit step nosings (one per riser per aisle) + lit aisle-edge strips on every tier.
  const stepLights = new THREE.InstancedMesh(box(1, 1, 1), mats.emissiveWarm, 36 + 60);
  stepLights.name = 'stepLights';
  let n = 0;
  for (let r = 1; r < ROWS; r++) for (const [xc, w] of [[-7.3, 1.24], [-2.4, 1.2], [2.4, 1.2], [7.3, 1.24]])
    setInst(stepLights, n++, xc, rowY(r) + 0.004, rowZ(r) - ROW_DEPTH / 2 + 0.015, w, 0.016, 0.04);
  for (let r = 0; r < ROWS; r++) for (const x of [-6.74, -2.92, -1.88, 1.88, 2.92, 6.74])
    setInst(stepLights, n++, x, rowY(r) + 0.011, rowZ(r), 0.02, 0.01, ROW_DEPTH - 0.02);
  stepLights.instanceMatrix.needsUpdate = true;
  stepLights.computeBoundingSphere();
  root.add(stepLights);

  /* ---------- 2. side walls: walnut dado, framed fabric panels, brass reveals, LED slits, sconces, speakers ---------- */

  const slitHaloGeos = [], sconceHaloGeos = [], washGeos = [];
  const panelThk = (i) => (i % 2 ? 0.16 : 0.10);
  const panelIndex = (z) => Math.round((z + 13) / 1.5);
  const wallFloor = (z) => (z < -8.3 ? 0.5 : floorAt(z));
  const PANEL_TOP = 6.45, DADO = 1.0;

  for (const s of [-1, 1]) {
    const ry = s > 0 ? -PI / 2 : PI / 2;                  // plane normal → into the hall
    put('wallDark', uvScale(plane(23, 7.6), 23, 7.6), s * 8, 3.8, -3, 0, ry, 0);

    for (let i = 0; i < 14; i++) {
      const zc = -13 + i * 1.5, thk = panelThk(i);
      const fLo = Math.min(wallFloor(zc - 0.75), wallFloor(zc + 0.75));
      const fHi = Math.max(wallFloor(zc - 0.75), wallFloor(zc + 0.75));
      // walnut dado reaching the floor everywhere along the panel, brass cap on top
      const dTop = fHi + DADO;
      put('trim', box(0.05, dTop - fLo, 1.5), s * (8 - 0.025), (dTop + fLo) / 2, zc);
      put('brass', box(0.035, 0.018, 1.5), s * (8 - 0.05), dTop, zc);
      // fabric panel with a dark walnut reveal around it
      const y0 = dTop + 0.12, h = PANEL_TOP - y0;
      put('trim', box(0.04, h + 0.12, 1.42), s * (8 - 0.02), y0 + h / 2, zc);
      put('panelR', uvScale(new RoundedBoxGeometry(thk, h, 1.30, 2, 0.03), 1.30, h), s * (8 - thk / 2 - 0.02), y0 + h / 2, zc);
    }
    // gaps between panels: warm LED slit in every second gap, brass bar in the others
    for (let i = 0; i < 13; i++) {
      const zg = -12.25 + i * 1.5;
      const y0 = Math.max(wallFloor(zg - 0.1), wallFloor(zg + 0.1)) + DADO + 0.12, h = PANEL_TOP - y0;
      if (i % 2 === 0) {
        put('emissiveWarm', box(0.03, h - 0.1, 0.03), s * 7.92, y0 + h / 2, zg);
        slitHaloGeos.push(place(plane(0.6, h + 0.3), s * 7.86, y0 + h / 2, zg, 0, ry, 0));
      } else {
        put('brass', box(0.02, h, 0.02), s * 7.93, y0 + h / 2, zg);
      }
    }
    // handrail along the wall aisle: sloped brass tube on short brackets
    {
      const z0 = TIER0_FRONT, z1 = LANDING_Z, y0 = 0.92, y1 = LANDING_Y + 0.92;
      const L = Math.hypot(z1 - z0, y1 - y0), ang = Math.atan2(y1 - y0, z1 - z0);
      put('brass', new THREE.CylinderGeometry(0.022, 0.022, L, 12), s * 7.86, (y0 + y1) / 2, (z0 + z1) / 2, PI / 2 - ang, 0, 0);
      for (let r = 0; r < ROWS; r += 2) {
        const zb = rowZ(r), yb = y0 + (zb - z0) * (y1 - y0) / (z1 - z0);
        put('brass', box(0.12, 0.02, 0.02), s * 7.93, yb - 0.03, zb);
      }
    }
    // frieze: brass reveal, walnut band, brass cornice rail
    put('brass', box(0.03, 0.022, 23), s * 7.96, 6.6, -3);
    put('trim', box(0.06, 0.42, 23), s * (8 - 0.03), 6.84, -3);
    put('brass', box(0.03, 0.03, 23), s * 7.95, 7.07, -3);
    // light spilling down the upper wall from the ceiling cove
    washGeos.push(place(plane(23, 2.2), s * 7.81, 5.95, -3, 0, ry, 0));

    // wall sconces: brass backplate + frosted glass tube + up/down scallop wash
    for (const zs of [-8.5, -1.0, 6.5]) {
      const face = 8 - panelThk(panelIndex(zs)) - 0.02;
      const sy = floorAt(zs) + 2.4;
      put('brass', box(0.03, 0.5, 0.12), s * (face - 0.015), sy, zs);
      put('brass', box(0.06, 0.04, 0.05), s * (face - 0.05), sy - 0.2, zs);
      put('brass', box(0.06, 0.04, 0.05), s * (face - 0.05), sy + 0.2, zs);
      put('emissiveWarm', new THREE.CylinderGeometry(0.035, 0.035, 0.36, 16), s * (face - 0.08), sy, zs);
      sconceHaloGeos.push(place(plane(1.2, 3.0), s * (face - 0.004), sy, zs, 0, ry, 0));
    }

    // speakers: front line array + two surrounds, brass grille frame on the inward face
    const speaker = (z, y, wz, h, dx) => {
      const face = 8 - panelThk(panelIndex(z)) - 0.02;
      const xc = s * (face - dx / 2 - 0.005);
      put('speakers', new RoundedBoxGeometry(dx, h, wz, 3, 0.03), xc, y, z);
      const xg = xc - s * (dx / 2 + 0.008);
      put('brass', box(0.015, 0.015, wz - 0.12), xg, y + h / 2 - 0.1, z);
      put('brass', box(0.015, 0.015, wz - 0.12), xg, y - h / 2 + 0.1, z);
      put('brass', box(0.015, h - 0.215, 0.015), xg, y, z + wz / 2 - 0.06);
      put('brass', box(0.015, h - 0.215, 0.015), xg, y, z - wz / 2 + 0.06);
    };
    speaker(-9.4, 4.6, 0.55, 1.6, 0.5);
    speaker(-4.0, 4.6, 0.45, 0.95, 0.4);
    speaker(3.5, 5.1, 0.45, 0.95, 0.4);
  }

  /* ---------- 3. ceiling: side soffits with cove glow, LED lines in recessed channels, downlights ---------- */

  const coveGeos = [];
  put('ceiling', uvScale(plane(16, 23), 16, 23), 0, 7.6, -3, PI / 2, 0, 0);
  for (const s of [-1, 1]) {
    put('ceiling', uvScale(box(1.3, 0.45, 23), 1.3, 23), s * (8 - 0.65), 7.375, -3);      // soffit, underside at 7.15
    put('brass', box(0.03, 0.03, 23), s * 6.69, 7.15, -3);                                   // lip
    put('emissiveWarm', box(0.03, 0.03, 22.6), s * 6.66, 7.585, -3);                       // hidden cove strip edge
    coveGeos.push(place(plane(2.2, 22.6), s * (6.7 - 1.1), 7.592, -3, PI / 2, 0, s < 0 ? PI : 0));
  }
  for (const x of [-4.0, -1.2, 1.2, 4.0]) {
    put('blackMetal', box(0.18, 0.045, 18.8), x, 7.578, -1.8);                               // aluminium channel
    put('emissiveWarm', plane(0.07, 18.4), x, 7.553, -1.8, PI / 2, 0, 0);
  }

  const downlights = new THREE.InstancedMesh(new THREE.CircleGeometry(0.08, 16), mats.emissiveWarm, 20);
  downlights.name = 'downlights';
  n = 0;
  for (const x of [-5.4, -2.6, 2.6, 5.4]) for (const z of [-9.5, -6, -2.5, 1, 4.5]) {
    setInst(downlights, n++, x, 7.58, z, 1, 1, 1, PI / 2, 0, 0);
    put('blackTrim', new THREE.RingGeometry(0.08, 0.13, 16), x, 7.585, z, PI / 2, 0, 0);
  }
  downlights.instanceMatrix.needsUpdate = true;
  downlights.computeBoundingSphere();
  root.add(downlights);

  // soft cones of light in the haze under each downlight: additive, fading downward and toward the cone edge
  const coneGeos = [];
  for (const x of [-5.4, -2.6, 2.6, 5.4]) for (const z of [-9.5, -6, -2.5, 1, 4.5])
    coneGeos.push(place(new THREE.CylinderGeometry(0.07, 0.8, 3.0, 28, 1, true), x, 7.56 - 1.5, z));
  const coneMat = new THREE.ShaderMaterial({
    uniforms: { uColor: { value: new THREE.Color(0xffd9a8) }, uIntensity: { value: 0.02 } },
    vertexShader: `varying vec2 vUv; varying vec3 vN; varying vec3 vP;
      void main(){ vUv = uv; vec4 mv = modelViewMatrix * vec4(position, 1.0); vP = mv.xyz; vN = normalize(normalMatrix * normal); gl_Position = projectionMatrix * mv; }`,
    fragmentShader: `uniform vec3 uColor; uniform float uIntensity; varying vec2 vUv; varying vec3 vN; varying vec3 vP;
      void main(){
        float y = clamp(vUv.y, 0.0, 1.0);
        vec3 n = vN / max(length(vN), 1e-4), v = -vP / max(length(vP), 1e-4);
        float e = clamp(abs(dot(n, v)), 0.0, 1.0);
        float a = clamp(y * y * e * e * uIntensity, 0.0, 1.0);   // no pow(): stays finite on every GPU
        gl_FragColor = vec4(uColor, a); }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
  });
  const cones = new THREE.Mesh(mergeGeometries(coneGeos, false), coneMat);
  cones.name = 'downlightCones'; cones.renderOrder = 4;
  root.add(cones);

  // glints: camera-facing star sprites with an anamorphic streak on every downlight, the door lights and the projector lens
  const glintTex = canvasTexture(256, 64, paintGlint);
  const glintWarm = new THREE.SpriteMaterial({ map: glintTex, color: 0xffdcb4, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0.38 });
  const glintCool = new THREE.SpriteMaterial({ map: glintTex, color: 0xcfe0ff, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0.55 });
  const addGlint = (mat, x, y, z, s) => { const sp = new THREE.Sprite(mat); sp.position.set(x, y, z); sp.scale.set(s * 4, s, 1); sp.renderOrder = 7; root.add(sp); };
  for (const x of [-5.4, -2.6, 2.6, 5.4]) for (const z of [-9.5, -6, -2.5, 1, 4.5]) addGlint(glintWarm, x, 7.52, z, 0.42);
  for (const s of [-1, 1]) addGlint(glintWarm, s * 6.5, 6.17, 8.36, 0.34);
  addGlint(glintCool, 0, 5.6, 8.4, 0.9);

  /* ---------- 4. front: walls, stage, masking, screen, clock, curtains ---------- */

  put('wallDark', uvScale(plane(16, 7.6), 16, 7.6), 0, 3.8, -11.5);
  put('screenWall', plane(13.6, 7.6), 0, 3.8, -11.35);                    // matte black screen surround

  // stage: wood top, dark front, brass lip with a lit edge underneath
  put('wood', uvScale(plane(16, 3.2), 16, 3.2), 0, 0.5, -9.9, -PI / 2, 0, 0);
  put('wallDark', uvScale(plane(16, 0.5), 16, 0.5), 0, 0.25, -8.3);
  for (let x = -7.95; x <= 7.951; x += 0.1) put('trim', box(0.05, 0.44, 0.03), x, 0.24, -8.285);   // walnut slats
  for (const s of [-1, 1]) {                                                                     // side steps up to the stage
    put('trim', box(1.0, 0.333, 0.3), s * 7.1, 0.1665, -8.15);
    put('trim', box(1.0, 0.167, 0.3), s * 7.1, 0.0835, -7.85);
    put('emissiveWarm', box(1.0, 0.012, 0.02), s * 7.1, 0.327, -8.0);
    put('emissiveWarm', box(1.0, 0.012, 0.02), s * 7.1, 0.161, -7.7);
  }
  put('brass', box(16, 0.03, 0.03), 0, 0.5, -8.3);
  put('emissiveWarm', box(16, 0.015, 0.02), 0, 0.47, -8.25);

  // screen masking: outer x ±6.30, y 0.60..6.32; inner = picture 12 × 5.2
  for (const s of [-1, 1]) put('screenFrame', box(0.3, 5.72, 0.25), s * 6.15, 3.46, -11.1);
  put('screenFrame', box(12, 0.3, 0.25), 0, 0.75, -11.1);
  put('screenFrame', box(12, 0.22, 0.25), 0, 6.21, -11.1);
  // lit brass line around the masking
  put('emissiveBrass', box(12.66, 0.02, 0.02), 0, 6.34, -10.96);
  put('emissiveBrass', box(12.66, 0.02, 0.02), 0, 0.58, -10.96);
  for (const s of [-1, 1]) put('emissiveBrass', box(0.02, 5.78, 0.02), s * 6.32, 3.46, -10.96);

  const screen = new THREE.Mesh(new THREE.PlaneGeometry(12, 5.2), new THREE.MeshBasicMaterial({ color: 0x080808 }));
  screen.position.set(SCREEN_C[0], SCREEN_C[1], SCREEN_C[2]);
  screen.name = 'screen';
  root.add(screen);

  const clock = new THREE.Mesh(new THREE.CircleGeometry(0.55, 48), new THREE.MeshBasicMaterial({ color: 0x080808, transparent: true }));
  clock.position.set(0, 6.9, -11.3);                                      // clears the masking top (6.32)
  clock.name = 'clock';
  root.add(clock);
  put('brass', new THREE.RingGeometry(0.55, 0.61, 48), 0, 6.9, -11.31);

  // pleated velvet curtains either side of the screen, under a dark pelmet
  for (const s of [-1, 1]) {
    const g = new THREE.PlaneGeometry(1.35, 7.1, 36, 10);
    const p = g.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), y = p.getY(i);
      p.setZ(i, Math.sin(x * 16) * 0.09 + Math.sin(x * 31 + y * 0.5) * 0.025);
    }
    g.computeVertexNormals();
    const curtain = new THREE.Mesh(g, mats.curtain);
    curtain.position.set(s * 7.125, 4.05, -10.5);
    curtain.castShadow = curtain.receiveShadow = true;
    curtain.name = 'curtain';
    root.add(curtain);
  }
  // valance across the whole front: dark box, brass edge, warm line washing the curtains below
  put('screenFrame', box(16, 0.18, 0.5), 0, 7.51, -10.9);
  put('brass', box(16, 0.02, 0.02), 0, 7.42, -10.64);
  put('emissiveWarm', box(15.6, 0.012, 0.03), 0, 7.41, -10.7);

  /* ---------- 5. back wall: ONLY planes facing -z (invisible from the overview camera) ---------- */

  put('wallDark', uvScale(plane(16, 7.6), 16, 7.6), 0, 3.8, 8.5, 0, PI, 0);
  {
    const yb = LANDING_Y, dTop = yb + DADO, y0 = dTop + 0.12, h = PANEL_TOP - y0;
    put('trim', box(11.9, DADO, 0.05), 0, yb + DADO / 2, 8.475);
    put('brass', box(11.9, 0.018, 0.035), 0, dTop, 8.45);
    for (const x of [-5.25, -3.75, -2.25, 2.25, 3.75, 5.25]) {
      put('trim', plane(1.42, h + 0.12), x, y0 + h / 2, 8.49, 0, PI, 0);
      put('wallPanel', uvScale(plane(1.30, h), 1.30, h), x, y0 + h / 2, 8.47, 0, PI, 0);
    }
    for (const x of [-4.5, -3.0, 3.0, 4.5]) put('emissiveWarm', box(0.03, h - 0.1, 0.03), x, y0 + h / 2, 8.47);
    put('brass', box(16, 0.022, 0.03), 0, 6.6, 8.46);
  }

  // projection booth: a wide dark window band with the main port and two small ports, brass frame and sill
  put('blackMetal', plane(2.96, 0.92), 0, 5.6, 8.488, 0, PI, 0);
  put('brass', plane(2.96, 0.02), 0, 6.06, 8.47, 0, PI, 0);
  for (const sx of [-1, 1]) {
    put('brass', plane(0.02, 0.92), sx * 1.48, 5.6, 8.47, 0, PI, 0);
    put('emissiveWarm', place(new THREE.CircleGeometry(0.045, 20), 0, 0, 0), sx * 0.95, 5.62, 8.466, 0, PI, 0);
    put('blackTrim', new THREE.RingGeometry(0.045, 0.075, 20), sx * 0.95, 5.62, 8.468, 0, PI, 0);
  }
  for (let x = -1.4; x <= 1.401; x += 0.08) put('trim', box(0.045, 1.25, 0.03), x, LANDING_Y + 1.12 + 0.625, 8.465);  // slats under the booth
  for (let x = -7.9; x <= 7.901; x += 0.08) put('trim', box(0.045, 0.9, 0.03), x, 7.1, 8.46);                       // slatted frieze
  const glass = new THREE.Mesh(place(plane(2.8, 0.74), 0, 5.6, 8.475, 0, PI, 0), new THREE.MeshBasicMaterial({ color: 0x2a2620 }));
  glass.name = 'boothGlass';
  root.add(glass);
  const lensMat = new THREE.MeshBasicMaterial({ color: 0xcfe0ff });
  lensMat.color.multiplyScalar(2.4);
  const lens = new THREE.Mesh(place(new THREE.CircleGeometry(0.07, 24), 0, 5.6, 8.465, 0, PI, 0), lensMat);
  lens.name = 'projectorLens';
  root.add(lens);
  put('brass', plane(2.96, 0.03), 0, 5.13, 8.47, 0, PI, 0);

  // doors with brass outlines, EXIT signs above them
  const doorGeos = [], exitGeos = [];
  for (const s of [-1, 1]) {
    const yd = LANDING_Y + 1.1;
    doorGeos.push(place(plane(1.0, 2.2), s * 6.5, yd, 8.48, 0, PI, 0));
    // walnut frame with depth, two inset panels on the leaf, a downlight and its wash above the door
    put('trim', box(0.09, 2.34, 0.12), s * 6.5 - 0.545, yd + 0.02, 8.44);
    put('trim', box(0.09, 2.34, 0.12), s * 6.5 + 0.545, yd + 0.02, 8.44);
    put('trim', box(1.18, 0.09, 0.12), s * 6.5, yd + 1.145, 8.44);
    put('trim', plane(0.38, 0.9), s * 6.5 - 0.22, yd + 0.5, 8.474, 0, PI, 0);
    put('trim', plane(0.38, 0.9), s * 6.5 + 0.22, yd + 0.5, 8.474, 0, PI, 0);
    put('trim', plane(0.38, 0.75), s * 6.5 - 0.22, yd - 0.55, 8.474, 0, PI, 0);
    put('trim', plane(0.38, 0.75), s * 6.5 + 0.22, yd - 0.55, 8.474, 0, PI, 0);
    put('emissiveWarm', new THREE.CylinderGeometry(0.05, 0.05, 0.02, 16), s * 6.5, 6.2, 8.42);
    sconceHaloGeos.push(place(plane(1.2, 3.0), s * 6.5, 6.0, 8.46, 0, PI, 0));
    put('emissiveWarm', box(0.03, 3.5, 0.03), s * 7.5, LANDING_Y + 1.12 + 1.75, 8.47);
    put('brass', plane(0.02, 2.24), s * 6.5 - 0.51, yd, 8.475, 0, PI, 0);
    put('brass', plane(0.02, 2.24), s * 6.5 + 0.51, yd, 8.475, 0, PI, 0);
    put('brass', plane(1.04, 0.02), s * 6.5, yd + 1.11, 8.475, 0, PI, 0);
    put('brass', plane(0.26, 0.025), s * 6.5 + s * 0.3, yd - 0.1, 8.472, 0, PI, 0);   // push bar
    put('blackMetal', plane(0.54, 0.24), s * 6.5, 5.05, 8.478, 0, PI, 0);
    exitGeos.push(place(plane(0.5, 0.2), s * 6.5, 5.05, 8.47, 0, PI, 0));
  }
  const doors = new THREE.Mesh(mergeGeometries(doorGeos, false), new THREE.MeshStandardMaterial({ color: 0x0b0a0d, roughness: 0.8 }));
  doors.name = 'doors';
  root.add(doors);

  const exitTex = canvasTexture(256, 96, paintExitSign);
  const exitMat = new THREE.MeshBasicMaterial({ map: exitTex, transparent: true, depthWrite: false, color: exitColor(mats.exitGreen) });
  const exitSigns = new THREE.Mesh(mergeGeometries(exitGeos, false), exitMat);
  exitSigns.name = 'exitSigns';
  root.add(exitSigns);
  if (typeof document !== 'undefined' && document.fonts && document.fonts.ready)
    document.fonts.ready.then(() => exitTex.userData.repaint()).catch(() => {});

  /* ---------- 6. light-wash decals (additive, no extra lights) ---------- */

  const haloMat = (tex, hex, opacity) => new THREE.MeshBasicMaterial({
    map: tex, color: hex, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false,
  });
  const slitHalos = new THREE.Mesh(mergeGeometries(slitHaloGeos, false), haloMat(canvasTexture(64, 8, paintSlitHalo), 0xffc98a, 0.16));
  slitHalos.name = 'slitHalos';
  root.add(slitHalos);
  const sconceHalos = new THREE.Mesh(mergeGeometries(sconceHaloGeos, false), haloMat(canvasTexture(128, 256, paintScallop), 0xffb978, 0.14));
  const wallWash = new THREE.Mesh(mergeGeometries(washGeos, false), haloMat(canvasTexture(8, 128, paintTopGrad), 0xffd2a0, 0.035));
  wallWash.name = 'wallWash';
  root.add(wallWash);
  const coveGlow = new THREE.Mesh(mergeGeometries(coveGeos, false), haloMat(canvasTexture(128, 8, paintEdgeGrad), 0xffd9a8, 0.13));
  coveGlow.name = 'coveGlow';
  root.add(coveGlow);
  sconceHalos.name = 'sconceHalos';
  root.add(sconceHalos);

  /* ---------- 7. brass row-number plates at the aisle ends ---------- */

  const plates = new THREE.InstancedMesh(box(0.12, 0.06, 0.012), mats.brass, ROWS * 4);
  plates.name = 'rowPlates';
  n = 0;
  for (let r = 0; r < ROWS; r++) for (const x of [-2.93, -1.87, 1.87, 2.93])
    setInst(plates, n++, x, rowY(r) + 0.56, rowZ(r) + 0.1, 1, 1, 1, 0, PI / 2, 0);
  plates.instanceMatrix.needsUpdate = true;
  plates.computeBoundingSphere();
  root.add(plates);

  /* ---------- merge buckets ---------- */

  for (const key of Object.keys(B)) {
    const spec = BUCKETS[key];
    const g = mergeGeometries(B[key], false);
    if (!g) { console.warn('hall.js: could not merge bucket', key); continue; }
    const mesh = new THREE.Mesh(g, spec.mat);
    mesh.name = 'hall-' + key;
    mesh.castShadow = !!spec.cast;
    mesh.receiveShadow = !!spec.recv;
    root.add(mesh);
  }

  /* ---------- 8. lights (10 objects incl. hemisphere + ambient; one shadow caster) ---------- */

  const lights = [];
  const hemi = new THREE.HemisphereLight(0x3f3a52, 0x120c0a, 0.32);
  const ambient = new THREE.AmbientLight(0xffffff, 0.05);
  lights.push(hemi, ambient);

  // Warm key from the back ceiling, travelling toward the screen: lights the seat backs (what both
  // the overview and the seat view look at) and drops each row's shadow onto the lower tier ahead.
  const key = new THREE.DirectionalLight(0xffe6c8, 0.3);
  key.position.set(3, 14.3, 4.5);
  key.target.position.set(0, 2, -3);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  const sc = key.shadow.camera;
  sc.left = -10; sc.right = 10; sc.top = 14; sc.bottom = -14; sc.near = 1; sc.far = 40;
  sc.updateProjectionMatrix();
  key.shadow.bias = -0.0004;
  key.shadow.normalBias = 0.03;
  root.add(key.target);
  lights.push(key);

  const screenLight = new THREE.PointLight(0xffffff, SCREEN_LIGHT_BASE, 26, 2);   // app.js drives colour/intensity
  screenLight.position.set(0, 3.2, -8.8);
  screenLight.name = 'screenLight';
  lights.push(screenLight);

  for (const z of [-6, 2]) {
    const cove = new THREE.PointLight(0xffd9a8, 6, 22, 2);
    cove.position.set(0, 7.0, z);
    lights.push(cove);
  }

  const sconceLights = [];
  for (const [x, z] of [[-7.55, -1.0], [7.55, -1.0]]) {
    const l = new THREE.PointLight(0xffc98a, SCONCE_I, 11, 2);
    l.position.set(x, floorAt(z) + 2.4, z);
    sconceLights.push(l);
    lights.push(l);
  }
  for (const l of lights) root.add(l);

  scene.add(root);

  /* ---------- per-frame hook: sconce flicker + projector lens pulse, zero allocations ---------- */

  const lensBase = lensMat.color.clone();
  function update(t) {
    for (let i = 0; i < sconceLights.length; i++)
      sconceLights[i].intensity = SCONCE_I * (1 + 0.035 * Math.sin(t * 7.3 + i) * Math.sin(t * 2.1 + i * 1.7));
    lensMat.color.copy(lensBase).multiplyScalar(1 + 0.04 * Math.sin(t * 3.1));
    glintWarm.opacity = 0.38 * (1 + 0.06 * Math.sin(t * 1.3));
    glintCool.opacity = 0.55 * (1 + 0.08 * Math.sin(t * 3.1));
  }

  return {
    screen,
    clock,
    screenLight,
    screenLightBase: SCREEN_LIGHT_BASE,
    bounds: { xMin: -7.5, xMax: 7.5, yMin: 0.6, yMax: 6.8, zMin: -8.2, zMax: 8.1 },
    floorAt: (z) => (z < -8.3 ? 0.5 : floorAt(z)),
    lights,
    update,
    group: root,
    keyLight: key,
    sconceLights,
  };
}

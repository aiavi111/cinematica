// atmosphere.js — Orbita hall: projector beam in haze + drifting dust motes.
// Contract: createAtmosphere({ THREE, scene }) → atm
//   atm.update(dt, timeSec, screenBrightness, screenColor)   atm.setEnabled(bool)
// Extras: atm.group, atm.beam, atm.dust, atm.lens, atm.haze[], atm.params (live tuning), atm.dispose()
// Draw calls: 4 (beam, dust points, projector lens halo, 1 screen-haze plane). No per-frame allocations.
// NOTE (supersedes the contract's "DoubleSide" for the beam): the beam shader integrates the FULL analytic
// chord through the convex frustum per fragment, so it must be rasterised exactly once per pixel.
// DoubleSide would draw a front AND a back fragment from outside (2× brightness), FrontSide would vanish
// when the camera flies inside the beam (tour waypoint at (0,5.5,7.5)). BackSide gives one fragment per
// pixel from inside and outside and keeps depth testing against seats/screen correct — do not change it.

import * as THREE_CORE from 'three';

// ---- fixed hall geometry (metres, Y up) ----
const BOOTH = [0, 5.6, 8.4];          // projection-booth window centre (back wall z = 8.5)
const SCREEN_C = [0, 3.5, -10.95];    // picture centre
const SCREEN_HALF = [6.0, 2.6];       // picture half-size → beam cross-section at the picture
const APERTURE_HALF_X = 0.18;         // beam half-width at the window (same 2.31 aspect as the screen)
const FAR_CAP_GAP = 0.45;             // far cap (tilted with the axis) stays ≥ 0.2 m in front of the picture, clear of any masking
const N_BEAM_MOTES = 700;
const N_FREE_MOTES = 250;

const BEAM_VERT = /* glsl */`
varying vec3 vWorld;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;

// Analytic chord integration through the projector frustum: correct from outside,
// from a seat and when the camera is inside the volume (BackSide + slab clipping).
const BEAM_FRAG = /* glsl */`
uniform vec3 uApex, uAxis, uRight, uUp, uColor;
uniform float uTanX, uTanY, uNear, uFar;
uniform float uTime, uFlicker, uGain, uPeak, uG, uFwdMax, uFall;
uniform sampler2D uNoise;
varying vec3 vWorld;

// Clip the ray against the half-space  num + t*den <= 0.
void clipHalf(float num, float den, inout float t0, inout float t1, inout bool miss) {
  if (abs(den) < 1e-6) { if (num > 0.0) miss = true; }
  else { float t = -num / den; if (den > 0.0) t1 = min(t1, t); else t0 = max(t0, t); }
}

// Haze density in projector space (x right, y up, z = distance along the axis from the apex).
float density(vec3 p) {
  float a = p.z;
  float u = p.x / (a * uTanX);
  float v = p.y / (a * uTanY);
  float u2 = u * u, v2 = v * v;
  float r = pow(u2 * u2 + v2 * v2 + 1e-6, 0.25);          // rounded-rectangle profile
  float soft = 1.0 - smoothstep(0.55, 1.0, r);
  float fall = 1.0 / (uFall * a * a + 1.0);                // ~inverse-square along the beam
  float start = smoothstep(uNear, uNear + 1.2, a);         // no hot disc right at the window
  float n1 = texture2D(uNoise, vec2(u * 0.35 + uTime * 0.012, a * 0.045 - uTime * 0.035)).r;
  float n2 = texture2D(uNoise, vec2(v * 0.20 - uTime * 0.009, a * 0.090 + uTime * 0.020)).g;
  float swirl = 0.65 + 0.35 * (n1 + n2);                   // slow haze drift, mean 1
  return soft * fall * start * swirl;
}

void main() {
  vec3 rdW = normalize(vWorld - cameraPosition);
  vec3 ro = cameraPosition - uApex;
  vec3 roP = vec3(dot(ro, uRight), dot(ro, uUp), dot(ro, uAxis));
  vec3 rdP = vec3(dot(rdW, uRight), dot(rdW, uUp), dot(rdW, uAxis));

  float t0 = 0.0, t1 = 1e9; bool miss = false;             // t0 = 0 handles a camera inside the beam
  clipHalf( roP.x - uTanX * roP.z,  rdP.x - uTanX * rdP.z, t0, t1, miss);
  clipHalf(-roP.x - uTanX * roP.z, -rdP.x - uTanX * rdP.z, t0, t1, miss);
  clipHalf( roP.y - uTanY * roP.z,  rdP.y - uTanY * rdP.z, t0, t1, miss);
  clipHalf(-roP.y - uTanY * roP.z, -rdP.y - uTanY * rdP.z, t0, t1, miss);
  clipHalf(uNear - roP.z, -rdP.z, t0, t1, miss);
  clipHalf(roP.z - uFar,   rdP.z, t0, t1, miss);
  if (miss || t1 <= t0) discard;

  float len = t1 - t0;
  float jitter = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
  float acc = 0.0;
  for (int i = 0; i < 6; i++) {
    float t = t0 + (float(i) + jitter) * (len / 6.0);
    acc += density(roP + rdP * t);
  }
  float optical = acc * (len / 6.0) * uGain;
  float L = uPeak * (1.0 - exp(-optical / uPeak));          // saturating: the along-axis view never whites out
  float cosT = dot(uAxis, -rdW);                             // 1 = looking straight into the projector
  float g2 = uG * uG;
  float phase = min(uFwdMax, pow((1.0 + g2) / max(1e-3, 1.0 + g2 - 2.0 * uG * cosT), 1.5));
  gl_FragColor = vec4(uColor * (L * phase * uFlicker), 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

// ---- small deterministic helpers (build time only) ----
function makeRng(seed) {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}

// Tileable smooth value noise, `cells` lattice points across `size` pixels.
function valueNoise(size, cells, seed) {
  const rnd = makeRng(seed);
  const lat = new Float32Array(cells * cells);
  for (let i = 0; i < lat.length; i++) lat[i] = rnd();
  const out = new Float32Array(size * size);
  const sc = cells / size;
  for (let y = 0; y < size; y++) {
    const fy = y * sc, y0 = Math.floor(fy), ty = fy - y0, sy = ty * ty * (3 - 2 * ty), y1 = (y0 + 1) % cells;
    for (let x = 0; x < size; x++) {
      const fx = x * sc, x0 = Math.floor(fx), tx = fx - x0, sx = tx * tx * (3 - 2 * tx), x1 = (x0 + 1) % cells;
      const a = lat[y0 * cells + x0], b = lat[y0 * cells + x1], c = lat[y1 * cells + x0], d = lat[y1 * cells + x1];
      const top = a + (b - a) * sx, bot = c + (d - c) * sx;
      out[y * size + x] = top + (bot - top) * sy;
    }
  }
  return out;
}

function makeNoiseTexture(THREE, size) {
  const data = new Uint8Array(size * size * 4);
  for (let ch = 0; ch < 4; ch++) {
    const n8 = valueNoise(size, 8, 11 + ch * 7), n16 = valueNoise(size, 16, 101 + ch * 13);
    for (let i = 0; i < size * size; i++) data[i * 4 + ch] = Math.round(255 * (0.65 * n8[i] + 0.35 * n16[i]));
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.minFilter = tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}

// Soft radial sprite (white, alpha ramp). Linear colour space: only the alpha ramp matters.
function makeRadialTexture(THREE, size, stops) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  for (const [pos, a] of stops) grd.addColorStop(pos, `rgba(255,255,255,${a})`);
  g.fillStyle = grd;
  g.fillRect(0, 0, size, size);
  return new THREE.CanvasTexture(c);
}

// Top surface under a given z (metres): stage 0.5, flat front floor 0, seating tiers r*0.28
// (rows at z = -4.2 + r*1.15, 1.15 deep). ceil() is the conservative choice whichever way the
// riser depth is laid out around the row centre, so room motes never spawn inside the risers.
function tierTop(z) {
  if (z < -8.3) return 0.5;
  if (z <= -4.8) return 0;
  return 0.28 * Math.min(9, Math.max(0, Math.ceil((z + 4.2) / 1.15)));
}

export function createAtmosphere(opts = {}) {
  const THREE = opts.THREE || THREE_CORE;
  const scene = opts.scene;

  // gain/peak kept in the un-saturated regime (optical/peak ≤ ~0.6 at the core) so the rounded-rectangle
  // rim and the inverse-square falloff survive: bright at the lens, dissolving toward the screen.
  const params = { gain: 0.15, peak: 0.34, g: 0.42, fwdMax: 3.0, fall: 0.11, dust: 0.0, haze: 0.012, spill: 0.26 };
  const COOL = new THREE.Color(0.72, 0.80, 1.0);
  const tint = new THREE.Color();
  const tmpV = new THREE.Vector3();

  const group = new THREE.Group();
  group.name = 'atmosphere';

  // ---- projector frame: virtual apex behind the window so the beam has a real aperture ----
  const W = new THREE.Vector3().fromArray(BOOTH);
  const S = new THREE.Vector3().fromArray(SCREEN_C);
  const axis = new THREE.Vector3().subVectors(S, W).normalize();
  const D = W.distanceTo(S);
  const apexBack = APERTURE_HALF_X * D / (SCREEN_HALF[0] - APERTURE_HALF_X);  // ≈ 0.69 m
  const apex = new THREE.Vector3().copy(W).addScaledVector(axis, -apexBack);
  const right = new THREE.Vector3(1, 0, 0);
  const up = new THREE.Vector3().crossVectors(right, axis).normalize();
  right.crossVectors(axis, up).normalize();
  const aFull = D + apexBack;
  const tanX = SCREEN_HALF[0] / aFull, tanY = SCREEN_HALF[1] / aFull;
  const aNear = apexBack, aFar = aFull - FAR_CAP_GAP;

  // Point in the frustum: a along the axis, u/v in [-1, 1] across the local cross-section.
  const framePoint = (a, u, v, out) => out.copy(apex).addScaledVector(axis, a)
    .addScaledVector(right, u * a * tanX).addScaledVector(up, v * a * tanY);

  // ---- beam mesh: closed convex frustum, outward winding verified against its centroid ----
  const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
  const verts = [];
  for (const a of [aNear, aFar]) for (const [u, v] of corners) verts.push(framePoint(a, u, v, new THREE.Vector3()));
  const centre = verts.reduce((c, p) => c.add(p), new THREE.Vector3()).multiplyScalar(1 / verts.length);
  const index = [];
  const pushQuad = (i0, i1, i2, i3) => {
    const a = verts[i0], b = verts[i1], c = verts[i2], d = verts[i3];
    const n = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a));
    const outward = new THREE.Vector3().add(a).add(b).add(c).add(d).multiplyScalar(0.25).sub(centre);
    if (n.dot(outward) < 0) index.push(i0, i2, i1, i0, i3, i2); else index.push(i0, i1, i2, i0, i2, i3);
  };
  pushQuad(0, 1, 2, 3); pushQuad(4, 5, 6, 7);                      // near / far caps
  pushQuad(0, 1, 5, 4); pushQuad(1, 2, 6, 5); pushQuad(2, 3, 7, 6); pushQuad(3, 0, 4, 7);
  const beamGeo = new THREE.BufferGeometry();
  beamGeo.setAttribute('position', new THREE.Float32BufferAttribute(verts.flatMap(p => [p.x, p.y, p.z]), 3));
  beamGeo.setIndex(index);
  beamGeo.computeBoundingSphere();

  const noiseTex = makeNoiseTexture(THREE, 128);
  const beamMat = new THREE.ShaderMaterial({
    uniforms: {
      uApex: { value: apex.clone() }, uAxis: { value: axis.clone() },
      uRight: { value: right.clone() }, uUp: { value: up.clone() },
      uTanX: { value: tanX }, uTanY: { value: tanY }, uNear: { value: aNear }, uFar: { value: aFar },
      uTime: { value: 0 }, uFlicker: { value: 1 }, uColor: { value: new THREE.Color(0.6, 0.66, 0.8) },
      uGain: { value: params.gain }, uPeak: { value: params.peak }, uG: { value: params.g },
      uFwdMax: { value: params.fwdMax }, uFall: { value: params.fall }, uNoise: { value: noiseTex },
    },
    vertexShader: BEAM_VERT,
    fragmentShader: BEAM_FRAG,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    side: THREE.BackSide,            // exactly one fragment per pixel from inside AND outside — see header note
    blending: THREE.AdditiveBlending,
    fog: false,                      // fog would pull additive light toward the dark fog colour
    toneMapped: true,
  });
  const beam = new THREE.Mesh(beamGeo, beamMat);
  beam.name = 'projectorBeam';
  beam.renderOrder = 5;
  group.add(beam);

  // ---- dust motes: Points, GPU-side drift/twinkle via onBeforeCompile ----
  const nMotes = N_BEAM_MOTES + N_FREE_MOTES;
  const pos = new Float32Array(nMotes * 3), col = new Float32Array(nMotes * 3), seed = new Float32Array(nMotes * 4);
  const rnd = makeRng(2026);
  for (let i = 0; i < nMotes; i++) {
    if (i < N_BEAM_MOTES) {
      const a = aNear + 0.8 + (aFar - aNear - 1.3) * Math.pow(rnd(), 1.6);   // denser near the bright booth end
      framePoint(a, (rnd() * 2 - 1) * 0.92, (rnd() * 2 - 1) * 0.92, tmpV);
      col[i * 3] = col[i * 3 + 1] = col[i * 3 + 2] = 1;
    } else {
      const x = (rnd() * 2 - 1) * 7.5, z = -13 + rnd() * 21;
      const yMin = Math.max(0.8, tierTop(z) + 0.3);                           // always above the tier/stage top
      tmpV.set(x, yMin + rnd() * (7.2 - yMin), z);
      col[i * 3] = 0.35; col[i * 3 + 1] = 0.3; col[i * 3 + 2] = 0.245;        // sparse warm room dust
    }
    pos[i * 3] = tmpV.x; pos[i * 3 + 1] = tmpV.y; pos[i * 3 + 2] = tmpV.z;
    seed[i * 4] = rnd() * Math.PI * 2;       // phase
    seed[i * 4 + 1] = 0.06 + rnd() * 0.22;   // drift rate (rad/s) — slow: peak speed ≈ 0.1 m/s, like real suspended dust
    seed[i * 4 + 2] = 0.6 + rnd();           // size factor
    seed[i * 4 + 3] = 0.4 + rnd();           // twinkle rate (rad/s)
  }
  const dustGeo = new THREE.BufferGeometry();
  dustGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  dustGeo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  dustGeo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 4));
  dustGeo.computeBoundingSphere();
  dustGeo.boundingSphere.radius += 0.4;     // room for the drift

  const dotTex = makeRadialTexture(THREE, 64, [[0, 1], [0.35, 0.35], [1, 0]]);
  const dustTime = { value: 0 };
  const dustMat = new THREE.PointsMaterial({
    size: 0.026, sizeAttenuation: true, map: dotTex, vertexColors: true,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false,
  });
  dustMat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = dustTime;
    let vs = shader.vertexShader.replace('void main() {', 'attribute vec4 aSeed;\nuniform float uTime;\nvoid main() {');
    // Each replacement is guarded: a chunk mismatch degrades to static motes, never an error.
    if (vs.includes('#include <begin_vertex>')) vs = vs.replace('#include <begin_vertex>',
      'float dAmp = 0.06 + 0.16 * fract(aSeed.x * 0.15915);\n' +
      'float dT = uTime * aSeed.y + aSeed.x;\n' +
      'vec3 transformed = position + vec3(sin(dT) * dAmp, sin(dT * 0.7 + aSeed.x * 1.7) * dAmp * 0.6, cos(dT * 1.3 + aSeed.x * 0.4) * dAmp);');
    if (vs.includes('#include <color_vertex>')) vs = vs.replace('#include <color_vertex>',
      '#include <color_vertex>\n#ifdef USE_COLOR\nvColor *= 0.55 + 0.45 * sin(uTime * aSeed.w + aSeed.x * 2.3);\n#endif');
    if (vs.includes('gl_PointSize = size;')) vs = vs.replace('gl_PointSize = size;', 'gl_PointSize = size * aSeed.z;');
    if (vs.includes('#include <logdepthbuf_vertex>')) vs = vs.replace('#include <logdepthbuf_vertex>',
      'gl_PointSize = clamp(gl_PointSize, 1.2, 7.0);\n#include <logdepthbuf_vertex>');
    shader.vertexShader = vs;
    dustMat.userData.shader = shader;
  };
  dustMat.customProgramCacheKey = () => 'orbita-dust';
  const dust = new THREE.Points(dustGeo, dustMat);
  dust.name = 'dust';
  dust.renderOrder = 6;
  dust.visible = false;   // floating motes removed on request (kept out of the scene)

  // ---- projector lens HALO only: hall.js owns the hard lens dot (0.07 m disc, blooms). This is a soft 0.2 m
  // additive glow around it, kept just under the bloom threshold so the halo is not doubled, and it breathes
  // slowly instead of following the 24 Hz shutter (bloom would turn that into a visible jitter).
  // Faces INTO the hall (FrontSide → invisible from the overview camera outside the back wall). ----
  const lensMat = new THREE.MeshBasicMaterial({
    map: dotTex, color: 0xffffff, transparent: true, depthWrite: false,
    blending: THREE.AdditiveBlending, side: THREE.FrontSide, fog: false,
  });
  const lens = new THREE.Mesh(new THREE.PlaneGeometry(0.2, 0.2), lensMat);
  lens.name = 'projectorLensHalo';
  lens.position.set(BOOTH[0], BOOTH[1], BOOTH[2] - 0.02);
  lens.rotation.y = Math.PI;        // face -z
  lens.renderOrder = 4;
  group.add(lens);

  // ---- faint air glow around the picture: ONE plane, larger than the picture (15 × 8 vs 12 × 5.2) and very
  // low opacity, so it reads as light in the air spilling onto the masking rather than a sheen on the image;
  // on black the lift stays ≤ ~15/255 so letterbox bars remain crisp. Radial alpha → no rectangle ever shows. ----
  const hazeTex = makeRadialTexture(THREE, 256, [[0, 1], [0.5, 0.45], [1, 0]]);
  const hazeGeo = new THREE.PlaneGeometry(15, 8);
  const haze = [-10.0].map((z) => {
    const m = new THREE.Mesh(hazeGeo, new THREE.MeshBasicMaterial({
      map: hazeTex, color: 0xffffff, transparent: true, opacity: params.haze, depthWrite: false,
      blending: THREE.AdditiveBlending, side: THREE.DoubleSide, fog: false,
    }));
    m.name = 'screenHaze';
    m.position.set(SCREEN_C[0], SCREEN_C[1], z);
    m.renderOrder = 3;
    group.add(m);
    return m;
  });

  // ---- picture light spilling onto the floor in front of the stage and onto the stage itself ----
  const spillTex = (() => {
    const c = document.createElement('canvas'); c.width = 4; c.height = 128;
    const g = c.getContext('2d'), gr = g.createLinearGradient(0, 0, 0, 128);
    gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.4, 'rgba(255,255,255,0.35)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr; g.fillRect(0, 0, 4, 128);
    return new THREE.CanvasTexture(c);
  })();
  const spillMat = new THREE.MeshBasicMaterial({ map: spillTex, color: 0xffffff, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending, fog: false });
  const spill = [[15, 3.5, 0.016, -6.55], [12.6, 2.5, 0.506, -9.6]].map(([w, d, y, z]) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, d), spillMat);
    m.rotation.x = -Math.PI / 2;                 // bright edge (texture top) faces the screen
    m.position.set(0, y, z); m.renderOrder = 2; m.name = 'screenSpill';
    group.add(m); return m;
  });

  if (scene) scene.add(group);

  // ---- per-frame ----
  let enabled = true;
  let clock = 0;
  const hash = (i) => { const s = Math.sin(i * 12.9898) * 43758.5453; return s - Math.floor(s); };
  const u = beamMat.uniforms;

  function update(dt, timeSec, screenBrightness, screenColor) {
    if (!enabled) return;
    clock = (typeof timeSec === 'number' && isFinite(timeSec)) ? timeSec : clock + (Number.isFinite(dt) ? dt : 0.016);
    const t = clock;
    const b = (typeof screenBrightness === 'number' && screenBrightness === screenBrightness)
      ? Math.min(1, Math.max(0, screenBrightness)) : 0.6;

    if (screenColor && screenColor.isColor) tint.copy(screenColor);
    else if (typeof screenColor === 'number') tint.setHex(screenColor);
    else tint.copy(COOL);
    tint.lerp(COOL, 0.5);

    // 24 Hz shutter shimmer (±5 %) + slow lamp breathing (beam/dust); the lens halo gets breathing only.
    const fi = Math.floor(t * 24), ff = t * 24 - fi, sm = ff * ff * (3 - 2 * ff);
    const h0 = hash(fi);
    const breathe = 1 + 0.03 * Math.sin(t * 1.9);
    const flicker = 0.95 + 0.10 * (h0 + (hash(fi + 1) - h0) * sm) + (breathe - 1);

    u.uTime.value = t;
    u.uFlicker.value = flicker;
    u.uColor.value.copy(tint).multiplyScalar(0.35 + 0.75 * b);
    u.uGain.value = params.gain; u.uPeak.value = params.peak; u.uG.value = params.g;
    u.uFwdMax.value = params.fwdMax; u.uFall.value = params.fall;

    dustTime.value = t;
    dustMat.color.copy(tint).multiplyScalar((0.4 + 0.5 * b) * flicker * params.dust);
    lensMat.color.copy(tint).multiplyScalar(1.2 * (0.6 + 0.4 * b) * breathe);   // soft halo, under the bloom threshold

    const ho = params.haze * (0.3 + b);                    // ∝ picture brightness: dark frames keep their blacks
    for (let i = 0; i < haze.length; i++) { haze[i].material.opacity = ho; haze[i].material.color.copy(tint); }
    spillMat.opacity = params.spill * (0.25 + b) * flicker; spillMat.color.copy(tint);
  }

  function setEnabled(on) {
    enabled = !!on;
    group.visible = enabled;
  }

  function dispose() {
    if (group.parent) group.parent.remove(group);
    beamGeo.dispose(); beamMat.dispose(); noiseTex.dispose();
    dustGeo.dispose(); dustMat.dispose(); dotTex.dispose();
    lens.geometry.dispose(); lensMat.dispose();
    hazeGeo.dispose(); hazeTex.dispose(); spillTex.dispose(); spillMat.dispose(); for (const m of spill) m.geometry.dispose();
    for (const m of haze) m.material.dispose();
  }

  return { update, setEnabled, group, beam, dust, lens, haze, spill, params, dispose };
}

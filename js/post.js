// post.js — cinematic post-processing chain for the auditorium.
// HDR scene (MSAA, half-float) → selective bloom (threshold: emissives + screen glow only)
// → grade pass (soft vignette, 24 fps film grain, slight corner chromatic aberration, linear exposure)
// → OutputPass LAST (ACES tone mapping + sRGB applied exactly once; renderer.toneMapping is never touched).
//
// Note for app.js: the scene is rendered off-screen (only the OutputPass quad touches the canvas), so the
// WebGLRenderer should be created with antialias:false — canvas MSAA is wasted while post is active.
import * as THREE_ from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

const QUALITY = {
  high: { bloomScale: 1.0, samples: 4, aberr: 0.0012 }, // bloom mip0 = half device res, MSAA up to 4×, 3-tap CA
  low:  { bloomScale: 0.5, samples: 0, aberr: 0 },      // bloom mip0 = quarter device res, no MSAA, 1 tap
};

// Adaptive MSAA: a 4× RGBA16F target at full DPR-2 resolution (2400×1600 ≈ 3.8 Mpx) costs ~180 MB plus two
// full-res resolves per frame — too much for a 2020 MacBook Air. Above PX_MSAA_DOWN device pixels the scene
// target drops to REDUCED_SAMPLES (the visual gain of 4× at that pixel density is small). PX_MSAA_UP < PX_MSAA_DOWN
// is hysteresis so dragging a window around the threshold does not rebuild the buffers on every resize event.
const PX_MSAA_DOWN = 2.6e6;
const PX_MSAA_UP = 2.2e6;
const REDUCED_SAMPLES = 2;

const GRADE_VS = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

// Runs in linear HDR before the OutputPass: nothing here may clamp to 0–1 or tone-map.
const GRADE_FS = /* glsl */ `
uniform sampler2D tDiffuse;
uniform float uAspect;
uniform float uTime;
uniform float uVignette;
uniform float uGrain;
uniform float uGrainCell;
uniform float uAberr;
uniform float uExposure;
varying vec2 vUv;

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

void main() {
  vec2 q = (vUv - 0.5) * 2.0;
  q.x *= uAspect;
  float d = length(q) / length(vec2(uAspect, 1.0)); // 0 at the centre, 1 in the corners

  vec3 col;
  if (uAberr > 0.0) {
    // radial chromatic aberration, ~2 px in the corners, none in the centre
    vec2 off = (vUv - 0.5) * uAberr * (0.3 + d * d);
    col = vec3(texture2D(tDiffuse, vUv + off).r, texture2D(tDiffuse, vUv).g, texture2D(tDiffuse, vUv - off).b);
  } else {
    col = texture2D(tDiffuse, vUv).rgb;
  }

  col *= mix(1.0, 1.0 - uVignette, smoothstep(0.35, 1.05, d));

  // film grain: uGrainCell-px cells, re-seeded 24×/s so it reads as film, not video static.
  // Every hash input stays < 1e4 so fract() keeps its precision (also under mediump): the frame index
  // (1024-frame cycle ≈ 43 s) is hashed separately into a bounded cell offset instead of scaling the seed.
  float f = mod(floor(uTime * 24.0), 1024.0);
  vec2 jitter = floor(vec2(hash12(vec2(f, 7.0)), hash12(vec2(f, 13.0))) * 1000.0);
  float n = hash12(floor(gl_FragCoord.xy / uGrainCell) + jitter) - 0.5;
  col = col * (1.0 + n * uGrain * 2.0) + n * uGrain * 0.15;

  gl_FragColor = vec4(max(col, 0.0) * uExposure, 1.0);
}`;

export function createPost({ THREE = THREE_, renderer, scene, camera }) {
  const caps = renderer.capabilities;
  const isWebGL2 = caps.isWebGL2 === true;
  const halfFloat = isWebGL2 || renderer.extensions.has('EXT_color_buffer_half_float');
  const rtType = halfFloat ? THREE.HalfFloatType : THREE.UnsignedByteType;
  const maxSamples = isWebGL2 ? (caps.maxSamples || 0) : 0;
  const reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

  // MSAA guard. The bloom pass blends additively back INTO the multisampled readBuffer after the RenderPass
  // output has already been resolved once. That is safe on three r160 desktop because
  // WebGLTextures.updateMultisampleRenderTarget invalidates the multisampled COLOR_ATTACHMENT0 after its resolve
  // blit ONLY when supportsInvalidateFramebuffer is true (Oculus Browser UA); the
  // WEBGL_multisampled_render_to_texture path (mobile Adreno/Mali) does not keep a separate multisampled colour
  // buffer either. In both cases the scene would be lost between the RenderPass and the bloom blend, so MSAA is
  // forced off there. Re-test this path (and the parity re-sync in render()) when three is upgraded past r160.
  const rttExt = renderer.extensions.has('WEBGL_multisampled_render_to_texture');
  const oculus = typeof navigator !== 'undefined' && /OculusBrowser/.test(navigator.userAgent || '');
  const msaaOK = isWebGL2 && maxSamples > 0 && !rttExt && !oculus;

  const size = new THREE.Vector2();
  let cssW = 1, cssH = 1, pr = renderer.getPixelRatio();
  let renderScale = 1;
  let quality = 'high', preset = QUALITY.high;
  let enabled = true, time = 0;
  let curSamples = 0, samplesOverride = null;

  const devW = () => Math.max(1, Math.round(cssW * pr * renderScale));
  const devH = () => Math.max(1, Math.round(cssH * pr * renderScale));

  // Sample count the scene target should have at the current device resolution.
  function wantSamples() {
    if (!msaaOK) return 0;
    const cap = samplesOverride === null ? preset.samples : samplesOverride;
    if (cap <= 0) return 0;
    let s = cap;
    if (samplesOverride === null) {
      const px = devW() * devH();
      const limit = (curSamples > 0 && curSamples < cap) ? PX_MSAA_UP : PX_MSAA_DOWN; // hysteresis
      if (px > limit) s = Math.min(s, REDUCED_SAMPLES);
    }
    return Math.min(s, maxSamples);
  }

  function makeTarget(samples, depth = true) {
    return new THREE.WebGLRenderTarget(devW(), devH(), {
      type: rtType, depthBuffer: depth, stencilBuffer: false, samples,
    });
  }

  /* ---------- composer & buffers ---------- */
  renderer.getSize(size);
  if (size.x > 0 && size.y > 0) { cssW = size.x; cssH = size.y; }
  curSamples = wantSamples();
  const composer = new EffectComposer(renderer, makeTarget(curSamples));
  composer.setPixelRatio(1); // the composer works in device pixels: resize() hands it devW()/devH() (integers)

  // The chain swaps exactly twice per frame (grade + output), so the RenderPass always draws into
  // renderTarget2 and renderTarget1 only ever receives the grade output. Keep MSAA on rt2 alone:
  // one resolve fewer per frame and ~75 % less memory on rt1. render() re-syncs the parity each frame.
  function fixBuffers() {
    const msaa = composer.renderTarget1;      // the target passed to the constructor / reset()
    composer.renderTarget2.dispose();         // its MSAA clone, never uploaded
    composer.renderTarget2 = msaa;
    composer.renderTarget1 = makeTarget(0, false); // only full-screen quads land here: no depth buffer needed
    composer.writeBuffer = composer.renderTarget1;
    composer.readBuffer = composer.renderTarget2;
  }
  fixBuffers();

  // Rebuilds both buffers when the wanted sample count changes (quality switch, pixel count crossing the threshold).
  function syncBuffers() {
    const s = wantSamples();
    if (s === curSamples) return;
    curSamples = s;
    composer.reset(makeTarget(s)); // disposes the previous rt1/rt2
    fixBuffers();
  }

  /* ---------- passes ---------- */
  const renderPass = new RenderPass(scene, camera);

  const bloom = new UnrealBloomPass(new THREE.Vector2(devW(), devH()), 0.45, 0.42, 0.85);
  bloom.highPassUniforms.smoothWidth.value = 0.2; // soft knee 0.85→1.05 linear luminance

  const grade = new ShaderPass({
    name: 'CinemaGradeShader',
    uniforms: {
      tDiffuse:   { value: null },
      uAspect:    { value: 1 },
      uTime:      { value: 0 },
      uVignette:  { value: 0.35 },
      uGrain:     { value: reduced ? 0 : 0.03 }, // static grain adds nothing for reduced-motion users: off, not frozen
      uGrainCell: { value: 2 },
      uAberr:     { value: preset.aberr },
      uExposure:  { value: 1 },
    },
    vertexShader: GRADE_VS,
    fragmentShader: GRADE_FS,
  });
  grade.material.toneMapped = false;
  const U = grade.uniforms; // ShaderPass clones the uniforms; this is the live set

  const output = new OutputPass();

  composer.addPass(renderPass);
  composer.addPass(bloom);
  composer.addPass(grade);
  composer.addPass(output);

  /* ---------- sizing ---------- */
  function applySizes() {
    const W = devW(), H = devH();
    bloom.setSize(Math.round(W * preset.bloomScale), Math.round(H * preset.bloomScale)); // composer.setSize resets it to full res
    U.uAspect.value = cssW / cssH;
    U.uGrainCell.value = Math.max(1, Math.round(pr * renderScale));
  }

  // w, h in CSS pixels — the same units as renderer.setSize(w, h, false).
  function resize(w, h) {
    if (!(w > 0 && h > 0)) return;
    cssW = w; cssH = h; pr = renderer.getPixelRatio();
    syncBuffers();                    // the sample count may change with the pixel count
    composer.setSize(devW(), devH()); // integers only: targets, bloom and the passes never see fractional sizes
    applySizes();
  }
  resize(cssW, cssH);

  /* ---------- API ---------- */
  function render(dt) {
    if (!enabled) { renderer.render(scene, camera); return; }
    time += Number.isFinite(dt) ? Math.min(Math.max(dt, 0), 0.1) : 1 / 60;
    if (time > 4096) time -= 4096; // 4096 s = 96 whole 1024-frame grain cycles: keeps floor(uTime*24) exact in float32
    U.uTime.value = time;
    if (composer.readBuffer !== composer.renderTarget2) composer.swapBuffers(); // keep the RenderPass on the MSAA buffer
    composer.render(dt);
  }

  function setEnabled(on) { enabled = !!on; }

  function setQuality(q) {
    const p = QUALITY[q];
    if (!p || q === quality) return;
    quality = q; preset = p;
    U.uAberr.value = p.aberr;
    resize(cssW, cssH); // syncBuffers() rebuilds the targets if the sample count changes
  }

  // Forces the scene target's MSAA sample count (0 = off, 2, 4 …; capped by the GPU and the MSAA guard);
  // null/undefined returns to the adaptive choice.
  function setSamples(n) {
    samplesOverride = (n === null || n === undefined) ? null : Math.max(0, Math.floor(Number(n) || 0));
    resize(cssW, cssH);
  }

  // Renders the scene + post at s × the canvas resolution (0.5–1); the OutputPass upsamples to the canvas.
  function setRenderScale(s) {
    s = Number.isFinite(s) ? Math.min(1, Math.max(0.5, s)) : 1;
    if (s === renderScale) return;
    renderScale = s;
    resize(cssW, cssH);
  }

  function setExposure(x) { U.uExposure.value = Number.isFinite(x) ? Math.max(0, x) : 1; }

  function setCamera(cam) { camera = cam; renderPass.camera = cam; }

  function dispose() {
    composer.dispose(); // disposes renderTarget1/2 + its copy pass
    bloom.dispose();
    grade.dispose();
    output.dispose();
  }

  return {
    render, resize, setEnabled, setQuality,
    getQuality: () => quality,
    setSamples, getSamples: () => curSamples,
    setRenderScale, getRenderScale: () => renderScale,
    setExposure, setCamera, dispose,
    composer, bloom, grade, uniforms: U,
  };
}

// seats.js — 180 cinema recliners as five InstancedMeshes (velvet fabric, shared armrest consoles,
// dark frame, brass cup-holder rings, brass number plates) plus one invisible instanced pick proxy.
// 5 draw calls for the whole auditorium (+3 in the shadow pass). Per-instance colours mark
// free / reserved / selected / hover; a tiny shader hook adds an emissive glow to selected seats.
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';

const ROWS = 10, COLS = 18;                          // blocks of 6 | 6 | 6 with two central aisles
const ARM_X = 0.3;                                  // armrests sit between seats (pitch 0.6 m) and are shared
const UV_PER_M = 4;                                 // UV units per metre of surface -> uniform velvet density
const BACK_PIVOT = [0, 0.46, 0.20], LEAN = 0.17;    // backrest assembly hinges at the cushion's rear edge, ~10 deg recline
const COL = { free: 0x9a1e2a, reserved: 0x3a383f, selected: 0xd8b257 };
const GLOW = { free: 0, reserved: 0, selected: 1.0 };
const GLOW_HOVER = { free: 0.12, reserved: 0.08, selected: 1.3 };

export function buildSeats({ THREE, scene, M }) {
  M = M || {};
  const _c = new THREE.Color(), WHITE = new THREE.Color(1, 1, 1);
  const _m = new THREE.Matrix4(), _t = new THREE.Matrix4();

  /* ---------- geometry helpers (seat local frame: x across, y up from the tier top, -z toward the screen) ---------- */

  // Box/RoundedBox faces come in the order +x -x +y -y +z -z with equal vertex counts and UV 0..1 per face;
  // rescale so one UV unit is 1/UV_PER_M metre on every face of every part.
  function scaleBoxUV(geo, w, h, d) {
    const uv = geo.attributes.uv, per = uv.count / 6;
    for (let i = 0; i < uv.count; i++) {
      const f = Math.floor(i / per);
      const su = f < 2 ? d : w, sv = (f === 2 || f === 3) ? d : h;
      uv.setXY(i, uv.getX(i) * su * UV_PER_M, uv.getY(i) * sv * UV_PER_M);
    }
    return geo;
  }
  const rbox = (w, h, d, seg, r) => scaleBoxUV(new RoundedBoxGeometry(w, h, d, seg, r), w, h, d);

  // z += -k*(x/hw)^2 (sides come forward). Normals fixed exactly for a z-graph displacement: n' = n - grad(f) * n.z,
  // so RoundedBox's duplicated seam vertices keep identical normals (no computeVertexNormals seams).
  function wrapZ(geo, hw, k) {
    const p = geo.attributes.position, n = geo.attributes.normal, inv = 1 / (hw * hw);
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), nz = n.getZ(i);
      p.setZ(i, p.getZ(i) - k * x * x * inv);
      const nx = n.getX(i) + 2 * k * x * inv * nz, ny = n.getY(i);
      const l = Math.hypot(nx, ny, nz) || 1;
      n.setXYZ(i, nx / l, ny / l, nz / l);
    }
    return geo;
  }

  // p' = pivot + Rx(rot) * (p + local); without a pivot: p' = Rx(rot) * p + local. Returns a non-indexed geometry.
  function place(geo, local, rot = 0, pivot = null) {
    if (pivot) {
      _m.makeRotationX(rot).multiply(_t.makeTranslation(local[0], local[1], local[2]));
      geo.applyMatrix4(_t.makeTranslation(pivot[0], pivot[1], pivot[2]).multiply(_m));
    } else {
      geo.applyMatrix4(_m.makeRotationX(rot).setPosition(local[0], local[1], local[2]));
    }
    return geo.index ? geo.toNonIndexed() : geo;
  }

  function merge(parts, name) {
    const merged = mergeGeometries(parts, false);
    if (!merged) { console.warn('[seats] merge failed:', name); return parts[0]; }
    let g = merged;
    try { g = mergeVertices(merged); } catch (e) { g = merged; }   // indexed: ~3x fewer vertex runs, seams keep their split normals
    g.computeBoundingSphere();
    return g;
  }

  /* ---------- one seat ---------- */

  // Velvet (tinted per instance): cushion, upholstered front panel, wrapped backrest, headrest pillow, two bolsters.
  const fabricGeo = merge([
    place(rbox(0.48, 0.16, 0.52, 2, 0.06), [0, 0.44, -0.03], 0.06),                                 // cushion, front edge up
    place(rbox(0.46, 0.34, 0.12, 1, 0.03), [0, 0.19, -0.22]),                                        // front panel / footrest
    place(wrapZ(rbox(0.48, 0.32, 0.21, 2, 0.075), 0.24, 0.07), [0, 0.19, 0.005], LEAN, BACK_PIVOT),  // lumbar cushion
    place(wrapZ(rbox(0.47, 0.30, 0.19, 2, 0.075), 0.235, 0.055), [0, 0.51, 0.015], LEAN, BACK_PIVOT), // shoulder cushion, channel above the lumbar
    place(wrapZ(rbox(0.42, 0.20, 0.20, 2, 0.075), 0.21, 0.03), [0, 0.74, 0.02], LEAN, BACK_PIVOT),   // headrest pillow
    place(rbox(0.08, 0.34, 0.14, 1, 0.025), [-0.20, 0.42, -0.10], LEAN, BACK_PIVOT),                 // left bolster
    place(rbox(0.08, 0.34, 0.14, 1, 0.025), [0.20, 0.42, -0.10], LEAN, BACK_PIVOT),                  // right bolster
  ], 'fabric');

  // Dark metal under the cushion.
  const frameGeo = merge([
    place(rbox(0.47, 0.36, 0.48, 1, 0.02), [0, 0.18, 0.0]),                                          // full-width base
    place(wrapZ(rbox(0.50, 0.70, 0.035, 1, 0.012), 0.25, 0.07), [0, 0.35, 0.13], LEAN, BACK_PIVOT), // two-tone rear shell
    place(rbox(0.48, 0.03, 0.56, 1, 0.01), [0, 0.015, -0.01]),                                       // plinth plate
  ], 'frame');

  // Shared armrest console (local origin at the armrest centre line).
  const armGeo = merge([
    place(rbox(0.09, 0.44, 0.56, 1, 0.015), [0, 0.22, -0.01]),                                       // full-height console
    place(rbox(0.10, 0.28, 0.60, 2, 0.03), [0, 0.56, 0.0]),                                          // padded arm body
    place(rbox(0.12, 0.05, 0.58, 1, 0.02), [0, 0.715, -0.01]),                                       // top pad
    place(new THREE.CylinderGeometry(0.031, 0.028, 0.012, 18), [0, 0.737, -0.20]),                   // cup well
  ], 'armrest');

  // Brass: cup-holder ring half-sunk into the armrest pad; small plate on the back of the headrest.
  const ringGeo = place(new THREE.TorusGeometry(0.034, 0.0065, 8, 20), [0, 0.742, -0.20], Math.PI / 2);
  ringGeo.computeBoundingSphere();
  const plateGeo = place(rbox(0.075, 0.028, 0.006, 1, 0.003), [0, 0.74, 0.126], LEAN, BACK_PIVOT);
  plateGeo.computeBoundingSphere();

  // Picking proxy (never rendered): two boxes enclosing the seat — cushion block + leaned backrest slab. It is only the
  // broad phase of pick(); the real fabric/frame geometry of the candidates decides. Shared armrests are not pickable.
  const proxyGeo = merge([
    place(new THREE.BoxGeometry(0.52, 0.56, 0.64), [0, 0.28, -0.02]),
    place(new THREE.BoxGeometry(0.54, 0.87, 0.40), [0, 0.445, 0.0], LEAN, BACK_PIVOT),
  ], 'proxy');
  for (const g of [fabricGeo, frameGeo]) g.computeBoundingBox();   // Mesh.raycast box test in pick()

  /* ---------- layout ---------- */

  const seats = [], seatPos = [], armPos = [];
  for (let r = 0; r < ROWS; r++) for (let k = 0; k < COLS; k++) {
    const x = -6.3 + k * 0.6 + (k >= 6 ? 1.2 : 0) + (k >= 12 ? 1.2 : 0);
    const y = r * 0.28, z = -4.2 + r * 1.15;
    seats.push({ row: r + 1, num: k + 1, label: `${r + 1}-${k + 1}`, x, y, z, eye: new THREE.Vector3(x, y + 1.15, z + 0.05), status: 'free', index: seats.length });
    seatPos.push(x, y, z);
    armPos.push(x - ARM_X, y, z);                                     // armrest on the left of every seat
    if (k === 5 || k === 11 || k === 17) armPos.push(x + ARM_X, y, z); // closing armrest at each block's right end
  }

  /* ---------- materials ---------- */

  const fabric = M.seatFabric || new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.85, metalness: 0 });
  if (fabric.color) fabric.color.setRGB(1, 1, 1);   // per-instance colour multiplies the base colour
  if ('vertexColors' in fabric) fabric.vertexColors = false;
  const armMat = M.armrest || new THREE.MeshStandardMaterial({ color: 0x17151c, roughness: 0.55, metalness: 0.05 });
  const frameMat = M.seatFrame || new THREE.MeshStandardMaterial({ color: 0x0f0e12, roughness: 0.45, metalness: 0.6 });
  const brass = M.brass || new THREE.MeshStandardMaterial({ color: 0xc9a654, metalness: 0.9, roughness: 0.3 });

  // Selected-seat glow: per-instance attribute aGlow -> emissive = aGlow * uSeatGlow * diffuse (lands above the bloom threshold).
  const glowArr = new Float32Array(seats.length);
  const glowAttr = new THREE.InstancedBufferAttribute(glowArr, 1).setUsage(THREE.DynamicDrawUsage);
  fabricGeo.setAttribute('aGlow', glowAttr);
  const glow = { value: 1.3 };
  const prevHook = fabric.onBeforeCompile;
  fabric.onBeforeCompile = (shader, renderer) => {
    if (prevHook) prevHook.call(fabric, shader, renderer);
    shader.uniforms.uSeatGlow = glow;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aGlow;\nvarying float vGlow;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvGlow = aGlow;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vGlow;\nuniform float uSeatGlow;')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += vGlow * uSeatGlow * diffuseColor.rgb;');
  };
  fabric.customProgramCacheKey = () => 'seats-glow';
  fabric.needsUpdate = true;

  /* ---------- instanced meshes ---------- */

  function instanced(geo, mat, pos, cast, name) {
    const n = pos.length / 3, mesh = new THREE.InstancedMesh(geo, mat, n);
    for (let i = 0; i < n; i++) mesh.setMatrixAt(i, _m.makeTranslation(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]));
    mesh.instanceMatrix.needsUpdate = true;
    mesh.castShadow = cast; mesh.receiveShadow = true; mesh.name = name;
    mesh.computeBoundingSphere();
    return mesh;
  }
  const fabricMesh = instanced(fabricGeo, fabric, seatPos, true, 'seatFabric');
  const frameMesh = instanced(frameGeo, frameMat, seatPos, true, 'seatFrame');
  const armMesh = instanced(armGeo, armMat, armPos, true, 'seatArmrests');
  const ringMesh = instanced(ringGeo, brass, armPos, false, 'seatCupRings');
  const plateMesh = instanced(plateGeo, brass, seatPos, false, 'seatPlates');
  const proxy = instanced(proxyGeo, new THREE.MeshBasicMaterial(), seatPos, false, 'seatPickProxy');
  proxy.visible = false; proxy.receiveShadow = false;   // raycast ignores visibility; the renderer skips it

  const group = new THREE.Group();
  group.name = 'seats';
  group.add(fabricMesh, frameMesh, armMesh, ringMesh, plateMesh, proxy);
  scene.add(group);

  /* ---------- state ---------- */

  let hovered = null;
  function recolour(s) {
    const st = COL[s.status] === undefined ? 'free' : s.status, hov = s === hovered;
    _c.setHex(COL[st]);
    if (hov) _c.multiplyScalar(1.45).lerp(WHITE, 0.04);
    fabricMesh.setColorAt(s.index, _c);
    fabricMesh.instanceColor.needsUpdate = true;
    glowArr[s.index] = hov ? GLOW_HOVER[st] : GLOW[st];
    glowAttr.needsUpdate = true;
  }
  for (const s of seats) recolour(s);

  function setStatus(seat, status) {
    if (!seat) return;
    seat.status = status;
    recolour(seat);
  }
  function setHover(seat) {
    seat = seat || null;
    if (seat === hovered) return;
    const prev = hovered;
    hovered = seat;
    if (prev) recolour(prev);
    if (hovered) recolour(hovered);
  }
  // pick: proxy boxes give the candidate seats (hits sorted by distance, entry faces only), then each candidate's
  // real fabric + frame geometry is raycast through a scratch Mesh carrying that instance's matrix; nearest real hit wins.
  const _hits = [], _real = [], _probe = new THREE.Mesh(), _stamp = new Int32Array(seats.length);
  const REAL_PARTS = [[fabricGeo, fabric], [frameGeo, frameMat]];
  let _tick = 0;
  function pick(raycaster) {
    _hits.length = 0;
    raycaster.intersectObject(proxy, false, _hits);
    if (!_hits.length) return null;
    _tick++;
    let best = null, bestD = Infinity;
    for (let h = 0; h < _hits.length; h++) {
      const hit = _hits[h], id = hit.instanceId;
      if (hit.distance > bestD) break;                 // real geometry lies inside its box: nothing nearer can follow
      if (id === undefined || _stamp[id] === _tick) continue;
      _stamp[id] = _tick;
      _probe.matrixWorld.multiplyMatrices(proxy.matrixWorld, _m.makeTranslation(seatPos[id * 3], seatPos[id * 3 + 1], seatPos[id * 3 + 2]));
      for (let p = 0; p < REAL_PARTS.length; p++) {
        _probe.geometry = REAL_PARTS[p][0]; _probe.material = REAL_PARTS[p][1];
        _real.length = 0;
        _probe.raycast(raycaster, _real);
        for (let k = 0; k < _real.length; k++) if (_real[k].distance < bestD) { bestD = _real[k].distance; best = seats[id]; }
      }
    }
    return best;
  }
  function dispose() {
    scene.remove(group);
    for (const g of [fabricGeo, frameGeo, armGeo, ringGeo, plateGeo, proxyGeo]) g.dispose();
    proxy.material.dispose();
  }

  return {
    seats, group, setStatus, setHover, pick,
    meshes: { fabric: fabricMesh, frame: frameMesh, armrest: armMesh, rings: ringMesh, plates: plateMesh, proxy },
    glow,      // { value } — emissive multiplier for selected/hovered seats, tune at runtime
    dispose,
  };
}

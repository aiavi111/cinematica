// app.js — orchestrates the 3D auditorium (modules) and the booking UI.
import * as THREE from 'three';
import {OrbitControls} from 'three/addons/controls/OrbitControls.js';

const $=s=>document.querySelector(s);
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const PRICE=450, MAX_SEATS=8;
const REDUCED=matchMedia('(prefers-reduced-motion: reduce)').matches;
const LOW=innerWidth<900||(navigator.hardwareConcurrency||8)<=4;
const DUR=k=>REDUCED?k*0.3:k;

const MOVIES=[
 // Kyrgyz films in Bishkek cinemas (titles, genre, length, age from manascinema.com, 25 Oct 2026).
 // poster: optional path to a poster file you are allowed to use, e.g. 'posters/aitmatov.jpg'.
 {id:'aitmatov',title:'Айтматов',genre:'Өмүр баян · Драма',dur:'1 саат 45 мүн',age:'12+',glow:0xffc98a,palette:['#06111c','#17384d','#9fd3e8'],type:'mountains',poster:'posters/aitmatov.jpg',still:'posters/aitmatov-wide.jpg'},
 // Rai 2 (Бейиш — апама кат): drama/adventure, 100 min; age listed as 12+ (afisha.uz) and 16+ (vokrug.tv)
 {id:'rai2',title:'Бейиш 2: Апама кат',genre:'Драма · Укмуштуу окуялар',dur:'1 саат 40 мүн',age:'12+',glow:0xffd28a,palette:['#0d1a12','#3c4a2a','#f2c46b'],type:'mountains',poster:'posters/rai2.jpg',still:'posters/rai2-wide.jpg'},
];
const TIMES=['13:00','16:15','19:00','22:00'];
const DAYS=[0,1,2,3].map(i=>{const d=new Date();d.setHours(12,0,0,0);d.setDate(d.getDate()+i);return d;});
const cap=s=>s.charAt(0).toUpperCase()+s.slice(1);
// Kyrgyz calendar words (no reliance on browser locale data)
const KY_DAYS=['Жекшемби','Дүйшөмбү','Шейшемби','Шаршемби','Бейшемби','Жума','Ишемби'];
const KY_DAYS_S=['Жк','Дш','Шш','Шр','Бш','Жм','Иш'];
const KY_MON=['январь','февраль','март','апрель','май','июнь','июль','август','сентябрь','октябрь','ноябрь','декабрь'];
const dayLabel=(d,i)=>i===0?'Бүгүн':KY_DAYS_S[d.getDay()];
const daySub=d=>`${d.getDate()}-${KY_MON[d.getMonth()].slice(0,3)}`;
const dayFull=d=>`${KY_DAYS[d.getDay()]}, ${d.getDate()}-${KY_MON[d.getMonth()]}`;
const fmt=n=>n.toLocaleString('ru-RU');

const state={movie:0,day:0,time:2,mode:'orbit',selected:new Set(),booked:new Set(),last:null,fx:true};
const sessionKey=()=>`${MOVIES[state.movie].id}|${state.day}|${state.time}`;
function hash(s){let h=2166136261;for(const c of s){h^=c.charCodeAt(0);h=Math.imul(h,16777619);}return h>>>0;}
function rng(seed){return()=>{seed|=0;seed=seed+0x6D2B79F5|0;let t=Math.imul(seed^seed>>>15,1|seed);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296;};}

const stage=$('#stage'), canvas=$('#c'), loadMsg=$('#loadMsg');
const setLoad=t=>{loadMsg.textContent=t;};
let toastT; function toast(t){const el=$('#toast');el.textContent=t;el.classList.add('show');clearTimeout(toastT);toastT=setTimeout(()=>el.classList.remove('show'),2400);}

/* ---------- module loading (dynamic, so a broken optional module degrades instead of killing the page) ---------- */
const VQ=new URL(import.meta.url).search;   // test pages pass ?t=...; the published page has none
async function loadModules(){
 const spec=[['materials','./materials.js',true],['hall','./hall.js',true],['seats','./seats.js',true],['screen','./screen.js',true],['post','./post.js',false],['atmosphere','./atmosphere.js',false]];
 const mods={};
 for(const [k,p,required] of spec){
  setLoad(`Жүктөлүүдө: ${k}…`);
  try{ mods[k]=await import(p+VQ); }
  catch(e){ console.error(`[module ${k}]`,e); if(required) throw new Error(`${k} модулу: ${e.message}`); mods[k]=null; }
 }
 return mods;
}

async function boot(){
 const mods=await loadModules();

 /* renderer */
 let renderer;
 try{ renderer=new THREE.WebGLRenderer({canvas,antialias:!LOW,powerPreference:'high-performance'}); }
 catch(e){ throw new Error('браузер WebGL колдобойт'); }
 renderer.setPixelRatio(Math.min(devicePixelRatio,LOW?1.5:2));
 renderer.outputColorSpace=THREE.SRGBColorSpace;
 renderer.toneMapping=THREE.ACESFilmicToneMapping; renderer.toneMappingExposure=0.85;
 renderer.shadowMap.enabled=true; renderer.shadowMap.type=THREE.PCFSoftShadowMap;

 const scene=new THREE.Scene();
 scene.background=new THREE.Color(0x050507);
 scene.fog=new THREE.FogExp2(0x0d0908,0.011);
 const camera=new THREE.PerspectiveCamera(58,1,0.1,120);
 const UP=new THREE.Vector3(0,1,0);
 const SCREEN_C=new THREE.Vector3(0,3.5,-10.95);
 const OVERVIEW={pos:new THREE.Vector3(0,5.6,7.9),target:new THREE.Vector3(0,2.2,-5)};
 camera.position.copy(OVERVIEW.pos); camera.lookAt(OVERVIEW.target);

 const controls=new OrbitControls(camera,canvas);
 controls.target.copy(OVERVIEW.target);
 controls.enableDamping=true; controls.dampingFactor=0.08;
 controls.minDistance=0.6; controls.maxDistance=16; controls.zoomToCursor=true;
 controls.maxPolarAngle=Math.PI*0.495; controls.minPolarAngle=0.15;
 controls.rotateSpeed=0.55; controls.panSpeed=0.9; controls.screenSpacePanning=false;

 /* world */
 setLoad('Материалдар жана жарык…');
 const M=mods.materials.createMaterials({THREE,renderer});
 if(M.env) scene.environment=M.env;
 /* brighter interior: lift surfaces and add a soft warm fill (tune BRIGHT to taste) */
 const BRIGHT={wall:1.0,ceiling:0.9,floor:0.95,wood:1.0,envBoost:1.2};
 const lift=(m,k)=>{ if(m&&m.color) m.color.multiplyScalar(k); };
 lift(M.wallPanel,BRIGHT.wall); lift(M.wallDark,BRIGHT.wall); lift(M.ceiling,BRIGHT.ceiling);
 lift(M.carpet,BRIGHT.floor); lift(M.carpetAisle,BRIGHT.floor); lift(M.wood,BRIGHT.wood);
 for(const k of ['wallPanel','wallDark','ceiling','carpet','carpetAisle','wood','seatFabric','curtain']){ const m=M[k]; if(m&&'envMapIntensity' in m) m.envMapIntensity*=BRIGHT.envBoost; }
 scene.add(new THREE.HemisphereLight(0xffe3c4,0x4a2e22,0.15));
 scene.add(new THREE.AmbientLight(0xffd8b0,0.03));
 // glossy stage wood and brass so the lights leave highlights on them
 // dimmer light sources: LED lines, step lights, downlights, sconce tubes, brass light lines
 if(M.emissiveWarm&&M.emissiveWarm.color) M.emissiveWarm.color.multiplyScalar(0.55);
 if(M.emissiveBrass&&M.emissiveBrass.color) M.emissiveBrass.color.multiplyScalar(0.6);
 if(M.wood){ M.wood.roughness=0.3; M.wood.envMapIntensity=(M.wood.envMapIntensity||1)*1.8; }
 if(M.brass){ M.brass.roughness=Math.min(M.brass.roughness??0.3,0.22); M.brass.envMapIntensity=(M.brass.envMapIntensity||1)*1.6; }
 setLoad('Зал курулуп жатат…');
 const hall=mods.hall.buildHall({THREE,scene,M});
 setLoad('Креслолор коюлуп жатат…');
 const seatsApi=mods.seats.buildSeats({THREE,scene,M});
 const seats=seatsApi.seats, seatsByLabel=new Map(seats.map(s=>[s.label,s]));
 setLoad('Проектор күйгүзүлүп жатат…');
 const scr=mods.screen.createScreen({THREE});
 hall.screen.material=new THREE.MeshBasicMaterial({map:scr.texture,toneMapped:true});
 hall.screen.material.color.setScalar(1.15);
 hall.clock.material=new THREE.MeshBasicMaterial({map:scr.clockTexture,transparent:true});
 let post=null, atm=null;
 try{ post=mods.post?mods.post.createPost({THREE,renderer,scene,camera}):null; post?.setQuality?.(LOW?'low':'high'); }catch(e){ console.warn('[post]',e); post=null; }
 try{ atm=mods.atmosphere?mods.atmosphere.createAtmosphere({THREE,scene}):null; }catch(e){ console.warn('[atmosphere]',e); atm=null; }
 const BOUNDS=hall.bounds||{xMin:-7.5,xMax:7.5,yMin:0.6,yMax:7.1,zMin:-8.2,zMax:8.1};
 const screenLightBase=hall.screenLightBase??(hall.screenLight?hall.screenLight.intensity:0);
 const glow=new THREE.Color(MOVIES[0].glow), glowTarget=new THREE.Color(MOVIES[0].glow);

 /* ---------- UI ---------- */
 function buildUI(){
  const mv=$('#movies');
  MOVIES.forEach((m,i)=>{const b=document.createElement('button');b.type='button';b.className='card';b.id='movie-'+m.id;
   const art=m.poster?`<img class="poster" src="${m.poster}" alt="" style="object-fit:cover">`:`<div class="poster" style="background:linear-gradient(160deg,${m.palette[0]},${m.palette[1]} 55%,${m.palette[2]})"></div>`;
   b.innerHTML=`${art}<div><div class="t">${m.title}</div><div class="m">${m.genre} · ${m.dur} · ${m.age}</div></div>`;
   b.onclick=()=>{state.movie=i;setMovie();applySession();};mv.appendChild(b);});
  const dv=$('#days');
  DAYS.forEach((d,i)=>{const b=document.createElement('button');b.type='button';b.className='chip';b.id='day-'+i;b.innerHTML=`${dayLabel(d,i)}<small>${daySub(d)}</small>`;b.onclick=()=>{state.day=i;applySession();};dv.appendChild(b);});
  const tv=$('#times');
  TIMES.forEach((t,i)=>{const b=document.createElement('button');b.type='button';b.className='chip time';b.id='time-'+i;b.textContent=t;b.onclick=()=>{state.time=i;applySession();};tv.appendChild(b);});
  $('#monthLbl').textContent=`${DAYS[0].getFullYear()}-ж. ${KY_MON[DAYS[0].getMonth()]}`;
  const g=$('#grid');
  const rl=n=>{const d=document.createElement('div');d.className='rl';d.textContent=n;return d;};
  for(let r=1;r<=10;r++){
   g.appendChild(rl(r));
   for(let k=1;k<=18;k++){
    if(k===7||k===13) g.appendChild(document.createElement('i'));
    const s=seatsByLabel.get(`${r}-${k}`); const b=document.createElement('button'); b.type='button'; b.className='seat'; b.textContent=k; b.title=`${r}-катар, ${k}-орун`; b.onclick=()=>toggleSeat(s); s.btn=b; g.appendChild(b);
   }
   g.appendChild(rl(r));
  }
 }
 function paint(s){
  seatsApi.setStatus(s,s.status);
  if(s.btn) s.btn.className='seat'+(s.status==='reserved'?' res':s.status==='selected'?' sel':'');
 }
 function setMovie(){
  const m=MOVIES[state.movie]; glowTarget.setHex(m.glow);
  [...$('#movies').children].forEach((c,i)=>c.classList.toggle('on',i===state.movie));
 }
 function applySession(){
  [...$('#days').children].forEach((c,i)=>c.classList.toggle('on',i===state.day));
  [...$('#times').children].forEach((c,i)=>c.classList.toggle('on',i===state.time));
  scr.drawClock(TIMES[state.time]);
  state.selected.clear(); state.last=null;
  // every seat starts free; only seats booked in this window become taken
  const key=sessionKey();
  for(const s of seats){ s.status=state.booked.has(key+'|'+s.label)?'reserved':'free'; paint(s); }
  refreshSel();
 }
 function selectedSorted(){return [...state.selected].sort((a,b)=>a.row-b.row||a.num-b.num);}
 function refreshSel(){
  const list=selectedSorted(), n=list.length;
  $('#selList').innerHTML=n?list.map(s=>`<span><b>${s.row}</b>-катар&nbsp;·&nbsp;<b>${s.num}</b>-орун</span>`).join(''):'<span class="none">Азырынча эч нерсе тандалган жок</span>';
  $('#cnt').textContent=n; $('#sum').textContent=fmt(n*PRICE);
  $('#btnView').disabled=!n; $('#btnBook').disabled=!n;
  $('#mapSub').textContent=`${MOVIES[state.movie].title} · ${dayFull(DAYS[state.day])} · ${TIMES[state.time]} · тандалды: ${n}`;
 }
 function toggleSeat(s){
  if(s.status==='reserved'){toast('Бул орун ээленген');return;}
  if(s.status==='selected'){s.status='free';state.selected.delete(s);if(state.last===s)state.last=null;}
  else{ if(state.selected.size>=MAX_SEATS){toast(`Бир жолу ${MAX_SEATS} орундан ашык эмес`);return;} s.status='selected';state.selected.add(s);state.last=s; }
  paint(s); refreshSel();
 }

 /* ---------- camera modes ---------- */
 const look={yaw:0,pitch:0,yaw0:0};
 let tween=null, tourI=-1;
 function flyTo(pos,lookAt,dur,onDone){
  const m=new THREE.Matrix4().lookAt(pos,lookAt,UP);
  tween={fromP:camera.position.clone(),toP:pos.clone(),fromQ:camera.quaternion.clone(),toQ:new THREE.Quaternion().setFromRotationMatrix(m),t0:performance.now(),dur:DUR(dur),onDone};
 }
 const ease=k=>k<.5?4*k*k*k:1-Math.pow(-2*k+2,3)/2;
 const eul=new THREE.Euler();
 function syncLook(){eul.setFromQuaternion(camera.quaternion,'YXZ');look.yaw=eul.y;look.pitch=eul.x;look.yaw0=eul.y;}
 function applyLook(){eul.set(look.pitch,look.yaw,0,'YXZ');camera.quaternion.setFromEuler(eul);}
 // Floor under a point: stage, front flat, raked tiers, back landing. The camera keeps EYE metres above it,
 // checking a little behind as well, so it never sinks into a riser or the seat backs.
 const floorAtHall=hall.floorAt||(z=>z<-4.775?0:Math.min(9,Math.max(0,Math.round((z+4.2)/1.15)))*0.28);
 const floorY=z=>z<-8.3?0.5:floorAtHall(z);
 const safeFloor=z=>Math.max(floorY(z),floorY(z+0.6));
 const EYE=1.1;
 const inside=(x,y,z)=>x>=BOUNDS.xMin&&x<=BOUNDS.xMax&&z>=BOUNDS.zMin&&z<=BOUNDS.zMax&&y<=BOUNDS.yMax&&y>=safeFloor(z)+EYE;
 function clampPos(){const p=camera.position;p.x=clamp(p.x,BOUNDS.xMin,BOUNDS.xMax);p.z=clamp(p.z,BOUNDS.zMin,BOUNDS.zMax);p.y=clamp(p.y,safeFloor(p.z)+EYE,BOUNDS.yMax);}
 // Orbit that never leaves the room: the chosen distance is remembered, and the visible camera is pulled
 // toward the pivot whenever a wall, the floor or the seats are in the way (no sticking, no passing through).
 let orbitDist=null, fitDist=null, focusTw=null;
 function clampTarget(){const t=controls.target;t.x=clamp(t.x,-6.5,6.5);t.z=clamp(t.z,-7.8,7.6);t.y=clamp(t.y,safeFloor(t.z)+EYE,5.6);}
 function orbitStep(now){
  const t=controls.target, p=camera.position;
  if(focusTw){const k=Math.min(1,(now-focusTw.t0)/focusTw.dur), e=ease(k); t.lerpVectors(focusTw.from,focusTw.to,e); orbitDist=focusTw.d0+(focusTw.d1-focusTw.d0)*e; fitDist=null; if(k>=1) focusTw=null;}
  if(orbitDist!==null){tmpV.copy(p).sub(t); if(tmpV.lengthSq()>1e-8){tmpV.setLength(orbitDist); p.copy(t).add(tmpV);}}
  const before=orbitDist;
  controls.update();
  clampTarget();
  let d=p.distanceTo(t);
  if(before!==null&&fitDist!==null&&fitDist<before-1e-3){const f=d/before; if(f<0.999) d=Math.max(controls.minDistance,fitDist*f);}  // zoom acts on what you see
  orbitDist=d; fitDist=d;
  tmpV.copy(p).sub(t); if(tmpV.lengthSq()<1e-8) tmpV.set(0,0.3,1);
  tmpV.setLength(d); p.copy(t).add(tmpV);
  if(!inside(p.x,p.y,p.z)){
   let lo=0,hi=1; const ox=p.x-t.x, oy=p.y-t.y, oz=p.z-t.z;
   for(let i=0;i<16;i++){const m=(lo+hi)/2; if(inside(t.x+ox*m,t.y+oy*m,t.z+oz*m)) lo=m; else hi=m;}
   p.set(t.x+ox*lo,t.y+oy*lo,t.z+oz*lo); fitDist=d*lo;
   if(fitDist<0.3) clampPos();
  }
  camera.lookAt(t);
 }
 function setSeg(mode){$('#modeOrbit').classList.toggle('on',mode==='orbit');$('#modeFly').classList.toggle('on',mode==='fly');}
 function showPill(text,btn='Залга кайтуу'){$('#pillText').textContent=text;$('#pillBtn').textContent=btn;$('#pill').classList.add('show');}
 function hidePill(){$('#pill').classList.remove('show');}
 function setMode(mode){
  tourI=-1; hidePill(); setSeg(mode);
  if(mode==='orbit'){
   controls.enabled=false; state.mode='transition';
   flyTo(OVERVIEW.pos,OVERVIEW.target,1100,()=>{controls.target.copy(OVERVIEW.target);orbitDist=null;fitDist=null;focusTw=null;controls.enabled=true;state.mode='orbit';});
  }else if(mode==='fly'){
   controls.enabled=false; tween=null;
   const p=camera.position;
   if(p.z>BOUNDS.zMax||p.y>BOUNDS.yMax||Math.abs(p.x)>BOUNDS.xMax){ state.mode='transition'; flyTo(new THREE.Vector3(0,3.8,6.5),SCREEN_C,900,()=>{syncLook();state.mode='fly';}); }
   else{ syncLook(); state.mode='fly'; }
  }
  canvas.style.cursor=mode==='orbit'?'grab':'crosshair';
 }
 function viewFromSeat(s){
  tourI=-1; controls.enabled=false; state.mode='transition'; setSeg(null);
  const eye=s.eye||new THREE.Vector3(s.x,s.y+1.15,s.z+0.05);
  flyTo(eye,SCREEN_C,1400,()=>{syncLook();state.mode='seat';});
  showPill(`Орундан көрүнүш · ${s.row}-катар, ${s.num}-орун`);
  canvas.style.cursor='crosshair';
 }
 const TOUR=[[-6.4,3.9,6.5,SCREEN_C],[-1.5,1.7,-6.6,new THREE.Vector3(0,3.4,5)],[6.4,3.4,-1,SCREEN_C],[0,5.5,7.5,SCREEN_C]];
 function startTour(){ if(tourI>=0) return; controls.enabled=false; setSeg(null); showPill('Зал боюнча тур','Өткөрүү'); tourI=0; state.mode='transition'; nextTour(); }
 function nextTour(){
  if(tourI<0) return;
  if(tourI>=TOUR.length){tourI=-1;setMode('orbit');return;}
  const [x,y,z,lk]=TOUR[tourI++]; flyTo(new THREE.Vector3(x,y,z),lk,2800,nextTour);
 }
 const tmpV=new THREE.Vector3();
 function dolly(f){
  if(state.mode==='orbit'){const cur=camera.position.distanceTo(controls.target);orbitDist=clamp(cur*f,controls.minDistance,controls.maxDistance);fitDist=null;}
  else if(state.mode==='fly'){camera.getWorldDirection(tmpV);camera.position.addScaledVector(tmpV,f<1?1.2:-1.2);clampPos();}
 }

 /* ---------- pointer / keys ---------- */
 const ray=new THREE.Raycaster(), ndc=new THREE.Vector2();
 let down=null, lastP=null, hovered=null;
 function pick(ev){
  const r=canvas.getBoundingClientRect(); ndc.x=((ev.clientX-r.left)/r.width)*2-1; ndc.y=-((ev.clientY-r.top)/r.height)*2+1;
  ray.setFromCamera(ndc,camera);
  const hit=seatsApi.pick(ray); if(hit) return hit;
  let best=null, bd=0.34*0.34;
  for(const s of seats){ seatC.set(s.x,s.y+0.62,s.z); const d=ray.ray.distanceSqToPoint(seatC); if(d<bd){bd=d;best=s;} }
  return best;
 }
 const seatC=new THREE.Vector3();
 // double-click: glide the pivot to that spot and halve the distance (a seat also ends up selected)
 canvas.addEventListener('dblclick',e=>{
  if(state.mode!=='orbit') return;
  const s=pick(e); let pt=null;
  if(s){ pt=new THREE.Vector3(s.x,s.y+0.9,s.z); if(s.status==='free') toggleSeat(s); }
  else{ for(const h of ray.intersectObjects(scene.children,true)){ const o=h.object, m=o.material; if(o.isPoints||o.isSprite||(m&&(m.blending===THREE.AdditiveBlending||(m.transparent&&m.opacity<0.6)))) continue; pt=h.point.clone(); break; } }
  if(!pt) return;
  const cur=camera.position.distanceTo(controls.target);
  focusTw={from:controls.target.clone(),to:pt,d0:cur,d1:clamp(cur*0.5,2.2,6),t0:performance.now(),dur:DUR(650)};
 });
 const tip=$('#tip');
 function setHover(s,ev){
  if(hovered===s&&!s) return;
  hovered=s; seatsApi.setHover(s);
  if(s){ const r=stage.getBoundingClientRect();
   tip.innerHTML=s.status==='reserved'?`${s.row}-катар, ${s.num}-орун · <b>ээленген</b>`:`${s.row}-катар, ${s.num}-орун · <b>${PRICE} сом</b>${s.status==='selected'?' · тандалды':''}`;
   tip.style.display='block'; tip.style.left=Math.min(ev.clientX-r.left+14,r.width-tip.offsetWidth-8)+'px'; tip.style.top=(ev.clientY-r.top+14)+'px';
   canvas.style.cursor=s.status==='reserved'?'not-allowed':'pointer';
  }else{ tip.style.display='none'; canvas.style.cursor=state.mode==='orbit'?'grab':'crosshair'; }
 }
 canvas.addEventListener('pointerdown',e=>{down={x:e.clientX,y:e.clientY,t:performance.now()};lastP={x:e.clientX,y:e.clientY};if(state.mode!=='orbit'){try{canvas.setPointerCapture(e.pointerId);}catch(_){}}canvas.focus({preventScroll:true});});
 canvas.addEventListener('pointermove',e=>{
  if(down&&lastP&&(state.mode==='fly'||state.mode==='seat')){
   const dx=e.clientX-lastP.x, dy=e.clientY-lastP.y;
   look.yaw-=dx*0.0032; look.pitch=clamp(look.pitch-dy*0.0032,-1.2,1.2);
   if(state.mode==='seat') look.yaw=clamp(look.yaw,look.yaw0-1.1,look.yaw0+1.1);
  }
  lastP={x:e.clientX,y:e.clientY};
  if(!down) setHover(pick(e),e); else if(hovered) setHover(null,e);
 });
 canvas.addEventListener('pointerup',e=>{
  if(down){const d=Math.hypot(e.clientX-down.x,e.clientY-down.y);if(d<6&&performance.now()-down.t<600){const s=pick(e);if(s)toggleSeat(s);}}
  down=null;
 });
 canvas.addEventListener('pointercancel',()=>{down=null;});
 canvas.addEventListener('pointerleave',e=>{setHover(null,e);});
 canvas.addEventListener('wheel',e=>{
  if(state.mode==='fly'){e.preventDefault();camera.getWorldDirection(tmpV);camera.position.addScaledVector(tmpV,-e.deltaY*0.01);clampPos();}
 },{passive:false});
 const keys=new Set();
 addEventListener('keydown',e=>{
  if(e.target&&e.target.matches&&e.target.matches('input,textarea,select')) return;
  if(e.code==='Escape'){closeModals();return;}
  keys.add(e.code);
  if(state.mode==='fly'&&['Space','ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(e.code)) e.preventDefault();
 });
 addEventListener('keyup',e=>keys.delete(e.code));
 addEventListener('blur',()=>keys.clear());
 const fwd=new THREE.Vector3(), right=new THREE.Vector3();
 function orbitKeys(dt){
  let mx=0,mz=0,my=0;
  if(keys.has('KeyW')||keys.has('ArrowUp')) mz+=1; if(keys.has('KeyS')||keys.has('ArrowDown')) mz-=1;
  if(keys.has('KeyD')||keys.has('ArrowRight')) mx+=1; if(keys.has('KeyA')||keys.has('ArrowLeft')) mx-=1;
  if(keys.has('KeyQ')) my+=1; if(keys.has('KeyE')) my-=1;
  if(!mx&&!mz&&!my) return;
  const sp=((keys.has('ShiftLeft')||keys.has('ShiftRight'))?7:3.5)*dt;
  camera.getWorldDirection(fwd); fwd.y=0; fwd.normalize(); right.crossVectors(fwd,UP).normalize();
  tmpV.set(0,0,0).addScaledVector(fwd,mz*sp).addScaledVector(right,mx*sp); tmpV.y=my*sp;
  // move the pivot, keep it in the room, then move the camera by exactly the same amount (never desync)
  oldT.copy(controls.target); controls.target.add(tmpV); clampTarget();
  tmpV.subVectors(controls.target,oldT); camera.position.add(tmpV);
 }
 const oldT=new THREE.Vector3();
 function updateFly(dt){
  const sp=((keys.has('ShiftLeft')||keys.has('ShiftRight'))?7:3.5)*dt;
  camera.getWorldDirection(fwd); fwd.y=0; fwd.normalize(); right.crossVectors(fwd,UP).normalize();
  if(keys.has('KeyW')||keys.has('ArrowUp')) camera.position.addScaledVector(fwd,sp);
  if(keys.has('KeyS')||keys.has('ArrowDown')) camera.position.addScaledVector(fwd,-sp);
  if(keys.has('KeyA')||keys.has('ArrowLeft')) camera.position.addScaledVector(right,-sp);
  if(keys.has('KeyD')||keys.has('ArrowRight')) camera.position.addScaledVector(right,sp);
  if(keys.has('KeyQ')||keys.has('Space')) camera.position.y+=sp;
  if(keys.has('KeyE')||keys.has('KeyC')) camera.position.y-=sp;
  clampPos();
 }

 /* ---------- buttons & modals ---------- */
 $('#modeOrbit').onclick=()=>setMode('orbit');
 $('#modeFly').onclick=()=>setMode('fly');
 $('#pillBtn').onclick=()=>setMode('orbit');
 $('#btnTour').onclick=startTour;
 $('#zin').onclick=()=>dolly(0.8); $('#zout').onclick=()=>dolly(1.25); $('#zreset').onclick=()=>setMode('orbit');
 $('#btnFull').onclick=()=>{const el=$('#app');if(document.fullscreenElement){document.exitFullscreen?.();}else{const p=el.requestFullscreen?.();if(p&&p.catch)p.catch(()=>toast('Бул жерде толук экран иштебейт'));}};
 $('#btnFx').onclick=()=>{state.fx=!state.fx;post?.setEnabled?.(state.fx);atm?.setEnabled?.(state.fx);$('#btnFx').classList.toggle('off',!state.fx);toast(state.fx?'Эффекттер күйгүзүлдү':'Эффекттер өчүрүлдү (тезирээк)');};
 $('#fov').oninput=e=>{camera.fov=+e.target.value;camera.updateProjectionMatrix();$('#fovV').textContent=e.target.value+'°';};
 $('#btnView').onclick=()=>{const s=state.last||selectedSorted()[0];if(s)viewFromSeat(s);};
 const clearSel=()=>{for(const s of [...state.selected]){s.status='free';paint(s);}state.selected.clear();state.last=null;refreshSel();};
 $('#btnClear').onclick=clearSel; $('#btnClear').onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();clearSel();}};
 const open=id=>$(id).classList.add('show'), closeModals=()=>document.querySelectorAll('.modal.show').forEach(m=>m.classList.remove('show'));
 document.querySelectorAll('.modal').forEach(m=>{m.addEventListener('click',e=>{if(e.target===m||e.target.closest('[data-close]'))closeModals();});});
 $('#btnMap').onclick=()=>open('#mapModal');
 $('#mapOk').onclick=()=>{closeModals();if(state.selected.size&&state.mode!=='seat')toast('Креслодон экранды көрүү үчүн «Орундан көрүнүш» баскычын басыңыз');};
 $('#btnHelp').onclick=()=>open('#helpModal');
 $('#btnBook').onclick=()=>{
  const list=selectedSorted(); if(!list.length) return;
  $('#bMovie').textContent=MOVIES[state.movie].title; $('#bDate').textContent=cap(dayFull(DAYS[state.day])); $('#bTime').textContent=TIMES[state.time];
  $('#bSeats').textContent=list.map(s=>`${s.row}-катар, ${s.num}-орун`).join('; '); $('#bSum').textContent=`${fmt(list.length*PRICE)} сом`;
  open('#bookModal');
 };
 $('#bookOk').onclick=()=>{
  const key=sessionKey(), n=state.selected.size; for(const s of state.selected) state.booked.add(key+'|'+s.label);
  closeModals(); applySession(); toast(`${n} орун брондолду. Бул демо, төлөөнүн кереги жок.`);
 };

 // test-only camera handle (the published page has no version query, so this stays off there)
 if(VQ) window.__dbg={camera,scene,renderer,state,controls,keys,view:(p,t)=>{tween=null;tourI=-1;controls.enabled=false;state.mode='static';camera.position.set(p[0],p[1],p[2]);camera.lookAt(t[0],t[1],t[2]);}};
 /* ---------- boot ---------- */
 buildUI(); setMovie(); applySession();
 scr.draw(MOVIES[state.movie],0);
 if(document.fonts?.ready) document.fonts.ready.then(()=>{scr.drawClock(TIMES[state.time]);});
 function resize(){const w=stage.clientWidth,h=stage.clientHeight;if(!w||!h)return;renderer.setSize(w,h,false);camera.aspect=w/h;camera.updateProjectionMatrix();post?.resize?.(w,h);}
 new ResizeObserver(resize).observe(stage); resize();
 let last=performance.now(), started=false, scrAcc=1;
 const SCR_DT=1/24;
 function loop(now){
  const dt=Math.min(0.05,(now-last)/1000), t=now/1000; last=now;
  if(tween){
   const k=Math.min(1,(now-tween.t0)/tween.dur), e=ease(k);
   camera.position.lerpVectors(tween.fromP,tween.toP,e); camera.quaternion.slerpQuaternions(tween.fromQ,tween.toQ,e);
   if(k>=1){const tw=tween;tween=null;tw.onDone?.();}
  }else if(state.mode==='orbit'){orbitKeys(dt);orbitStep(now);}
  else if(state.mode==='fly'){updateFly(dt);applyLook();}
  else if(state.mode==='seat'){applyLook();}
  scrAcc+=dt; if(scrAcc>=SCR_DT){ scr.draw(MOVIES[state.movie],t); scrAcc=0; }
  const b=scr.brightness?scr.brightness():0.6;
  glow.lerp(glowTarget,0.04);
  if(hall.screenLight){ hall.screenLight.color.copy(glow); hall.screenLight.intensity=screenLightBase*(0.35+0.9*b); }
  hall.update?.(t,dt);
  if(state.fx) atm?.update?.(dt,t,b,glow);
  if(post&&state.fx) post.render(dt); else renderer.render(scene,camera);
  if(!started){started=true;$('#loading').classList.add('hide');}
  requestAnimationFrame(loop);
 }
 requestAnimationFrame(loop);
}

boot().catch(e=>{ console.error(e); setLoad('Залды ачуу мүмкүн болбоду: '+(e&&e.message?e.message:e)); document.querySelector('#loading .bar')?.remove(); });

# Volumetric Light Intro (WebGL2 raymarch) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a standalone prototype that lights the retro monitor with TRUE shadow-aware volumetric light — warm god-ray beams that scatter through fog and are broken by the monitor's silhouette — using a WebGL2 raymarch post-pass in our existing three r0.152.2 stack.

**Architecture:** Render the scene (with one hero shadow-casting DirectionalLight) into a color+depth render target. A fullscreen post-pass reconstructs each pixel's world position from depth, marches the view ray from the camera to that hit point, samples the hero light's shadow map at each step to test in-light vs in-shadow, and accumulates warm in-scatter (bayer-dithered, Henyey-Greenstein phase). The accumulated glow is composited additively over the scene. An `arc` (0→1) parameter drives the light's position + volumetric density/intensity + a front-lit reveal + fade, with play/scrub UI so the look is judged live.

**Tech Stack:** three.js r0.152.2 (WebGLRenderer, WebGL2), GLSL ES 1.00 (three's default ShaderMaterial), CanvasTexture, GLTFLoader+DRACOLoader, plain browser ES modules via importmap. No bundler, no npm.

## Global Constraints

- three.js **r0.152.2** only, loaded via the existing importmap: bare specifiers `three` and `three/addons/` → `https://cdn.jsdelivr.net/npm/three@0.152.2/examples/jsm/`. No other deps.
- Plain browser ES modules. No build step. No TypeScript. GLSL is **ES 1.00** (three default — use `texture2D`, `gl_FragColor`, `varying`; do NOT use `texture()`/`out` GLSL3 syntax unless the material is `glslVersion: THREE.GLSL3`).
- Warm Edison amber constant: `const WARM = 0xffb86b;`.
- All work lives in ONE new throwaway file: `prototype-volumetric.html` at the repo root. Do NOT touch `js/Intro.js` or the app — integration is a separate follow-up plan.
- Serve from repo root; the model is at `/models/tv1.glb` (Draco-compressed; decoder path `https://cdn.jsdelivr.net/npm/three@0.152.2/examples/jsm/libs/draco/`).
- Monitor mesh names in the GLB: `Cube`, `Cube007`, `Cube006`, `Rubber`, `Glass` (TV body/parts), `Plane` (the ledge/cyclorama). The `Glass` (screen) must be blacked out: `glass.material = new THREE.MeshBasicMaterial({color:0x040404, toneMapped:false})`.
- Renderer config: `toneMapping = THREE.CineonToneMapping`, `outputEncoding = THREE.sRGBEncoding`, `shadowMap.enabled = true`, `shadowMap.type = THREE.PCFSoftShadowMap`. The prototype renders WebGL2 (default in r152 when available).
- Camera (fixed): `position (0,-0.7,12.5)`, `lookAt(0,0.6,0)`, fov 45, near 0.1, far 400. SUBJECT (monitor centre) = `(0,0.3,0.4)`.
- Verification is **visual/framebuffer**, not unit tests: each task ends by loading the page in the running preview, confirming **zero console errors**, and checking the framebuffer (a returned brightness grid / probe) and/or a screenshot against the task's expected result. The orchestrator performs these checks between tasks.

---

## File Structure

- `prototype-volumetric.html` — the entire prototype: importmap, scene setup, render targets, the hero light, the volumetric ShaderMaterial + fullscreen pass, the arc choreography, and the play/scrub + slider UI. Single self-contained file (mirrors the existing `prototype-rigs.html` scaffolding pattern).

There is exactly one file because this is a throwaway visual prototype; splitting it would add ceremony without benefit. The GLSL lives inline as template strings.

---

### Task 1: Scaffold — scene, monitor, hero shadow light, color+depth render target, passthrough display

**Files:**
- Create: `prototype-volumetric.html`

**Interfaces:**
- Consumes: nothing.
- Produces (module-scope names later tasks rely on):
  - `renderer` (THREE.WebGLRenderer), `scene`, `camera` (PerspectiveCamera), `SUBJECT` (THREE.Vector3), `WARM` (0xffb86b).
  - `sun` (THREE.DirectionalLight, castShadow true, the hero light).
  - `sceneRT` (THREE.WebGLRenderTarget with `.depthTexture` a THREE.DepthTexture).
  - `fsQuad`: three's `FullScreenQuad` (a NAMED export of `three/addons/postprocessing/Pass.js` in r152 — `import { FullScreenQuad }`, then `new FullScreenQuad(passMat)`; it has a `.render(renderer)` method). NOT `Pass.FullScreenQuad` (removed in r152).
  - `tick(now)` render loop calling `renderFrame()`.
  - `renderFrame()`: renders `scene`→`sceneRT`, then displays `sceneRT.texture` to screen via a passthrough material (this task) — later tasks swap the passthrough for the volumetric material.

- [ ] **Step 1: Create the file with scaffold + passthrough**

Create `prototype-volumetric.html`:

```html
<!DOCTYPE html>
<!-- PROTOTYPE — throwaway. True WebGL2 volumetric (shadow-aware raymarch) god-ray
     lighting on the monitor. Not wired into the app. Delete once validated. -->
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>PROTOTYPE — volumetric</title>
<style>
  html,body{margin:0;height:100%;background:#000;overflow:hidden;font-family:ui-monospace,monospace}
  #c{display:block;width:100vw;height:100vh}
  .panel{position:fixed;top:12px;left:12px;z-index:10;background:rgba(0,0,0,.55);color:#ffd9a8;padding:10px 12px;border-radius:8px;font-size:11px;line-height:1.9;backdrop-filter:blur(6px);border:1px solid rgba(255,200,120,.2);max-width:240px;user-select:none}
  .panel label{display:flex;align-items:center;justify-content:space-between;gap:8px}
  .panel input[type=range]{width:120px;accent-color:#ffb86b}
  .play{position:fixed;bottom:18px;right:18px;z-index:10;background:rgba(0,0,0,.55);color:#ffd9a8;border:1px solid rgba(255,200,120,.2);padding:8px 12px;border-radius:8px;font-size:12px;cursor:pointer}
  .err{position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);color:#ff8a8a;font-size:13px;background:rgba(0,0,0,.7);padding:14px;border-radius:8px;max-width:60vw;z-index:20;display:none;white-space:pre-wrap}
</style></head>
<body>
  <canvas id="c"></canvas>
  <div class="panel" id="panel">
    <div id="state">loading…</div><hr>
    <label>exposure <input id="exposure" type="range" min="0.15" max="2.5" step="0.05" value="1.0"></label>
    <label>density <input id="density" type="range" min="0" max="2.5" step="0.02" value="0.8"></label>
    <label>intensity <input id="intensity" type="range" min="0" max="3" step="0.05" value="1.0"></label>
    <label>steps <input id="steps" type="range" min="16" max="96" step="8" value="56"></label>
  </div>
  <div class="play" id="playbtn">⏸ pause &nbsp;·&nbsp; <span id="scrub">arc 0%</span></div>
  <div class="err" id="err"></div>

  <script type="importmap">
  { "imports": {
    "three": "https://cdn.jsdelivr.net/npm/three@0.152.2/build/three.module.js",
    "three/addons/": "https://cdn.jsdelivr.net/npm/three@0.152.2/examples/jsm/"
  } }
  </script>
  <script type="module">
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';

const WARM = 0xffb86b;
const SUBJECT = new THREE.Vector3(0, 0.3, 0.4);
const showErr = (e)=>{ const el=document.getElementById('err'); el.style.display='block'; el.textContent=String(e&&e.stack||e); console.error(e); };
window.addEventListener('error', (e)=>showErr(e.message));

const canvas = document.getElementById('c');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio,2)); renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.CineonToneMapping; renderer.outputEncoding = THREE.sRGBEncoding;
renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(45, innerWidth/innerHeight, 0.1, 400);
camera.position.set(0,-0.7,12.5); camera.lookAt(0,0.6,0);
scene.add(new THREE.AmbientLight(0xffffff, 0.02));

// Hero shadow-casting light (the lamp). Its shadow map breaks the volumetric beams.
const sun = new THREE.DirectionalLight(WARM, 0);
sun.castShadow = true; sun.shadow.mapSize.set(2048,2048);
const sc = sun.shadow.camera; sc.left=-7; sc.right=7; sc.top=7; sc.bottom=-7; sc.near=1; sc.far=120; sc.updateProjectionMatrix();
sun.shadow.bias = -0.0005; sun.shadow.normalBias = 0.04;
sun.position.set(2,4,-9); sun.target.position.copy(SUBJECT); scene.add(sun, sun.target);

// Color + depth render target for the scene (depth feeds the raymarch).
function makeRT(){ const rt = new THREE.WebGLRenderTarget(innerWidth, innerHeight, { minFilter:THREE.LinearFilter, magFilter:THREE.LinearFilter });
  rt.depthTexture = new THREE.DepthTexture(innerWidth, innerHeight); rt.depthTexture.type = THREE.UnsignedShortType; return rt; }
let sceneRT = makeRT();

// Passthrough display material (swapped for the volumetric material in Task 4).
const passMat = new THREE.ShaderMaterial({
  uniforms: { tDiffuse:{value:null} },
  vertexShader: `varying vec2 vUv; void main(){ vUv=uv; gl_Position=vec4(position.xy,0.0,1.0); }`,
  fragmentShader: `varying vec2 vUv; uniform sampler2D tDiffuse; void main(){ gl_FragColor = texture2D(tDiffuse, vUv); }`,
  depthTest:false, depthWrite:false,
});
const fsQuad = new FullScreenQuad(passMat);

let monitorReady = false;
const draco = new DRACOLoader(); draco.setDecoderPath('https://cdn.jsdelivr.net/npm/three@0.152.2/examples/jsm/libs/draco/');
const loader = new GLTFLoader(); loader.setDRACOLoader(draco);
loader.load('/models/tv1.glb', (g)=>{
  scene.add(g.scene);
  for (const n of ['Cube','Cube007','Cube006','Rubber','Glass']) { const m=g.scene.getObjectByName(n); if(m){m.castShadow=true;m.receiveShadow=true;} }
  const glass=g.scene.getObjectByName('Glass'); if(glass) glass.material=new THREE.MeshBasicMaterial({color:0x040404,toneMapped:false});
  const plane=g.scene.getObjectByName('Plane'); if(plane){plane.receiveShadow=true;renderer.localClippingEnabled=true;plane.material.clippingPlanes=[new THREE.Plane(new THREE.Vector3(0,-1,0),-1.9)];}
  monitorReady = true; document.getElementById('state').textContent='ready';
}, undefined, (e)=>showErr('GLB load failed: '+e));

const ctrl = { exposure:exposure, density:density, intensity:intensity, steps:steps };
function applyControls(){ renderer.toneMappingExposure = +ctrl.exposure.value; }
Object.values(ctrl).forEach(el=>el.addEventListener('input', applyControls));

let arc = 0.25, playing = false, last = performance.now();
function placeSun(a){ // simple arc for now; refined in Task 6
  const th = THREE.MathUtils.degToRad(200 + (40-200)*a);
  sun.position.set(SUBJECT.x+1.0, SUBJECT.y + Math.sin(th)*6, SUBJECT.z + Math.cos(th)*9);
  sun.target.position.copy(SUBJECT); sun.target.updateMatrixWorld();
  sun.intensity = 2.0;
}
function renderFrame(){
  // 1) scene → sceneRT (lights + shadows)
  renderer.setRenderTarget(sceneRT); renderer.clear(); renderer.render(scene, camera);
  // 2) display sceneRT to screen (passthrough for now)
  passMat.uniforms.tDiffuse.value = sceneRT.texture;
  renderer.setRenderTarget(null); fsQuad.render(renderer);
}
function tick(now){
  const dt=Math.min(0.05,(now-last)/1000); last=now;
  if (playing) arc=(arc+dt/9)%1;
  if (monitorReady){ placeSun(arc); renderFrame(); }
  document.getElementById('scrub').textContent='arc '+Math.round(arc*100)+'%';
  requestAnimationFrame(tick);
}
addEventListener('keydown',(e)=>{ if(e.key===' '){playing=!playing; document.getElementById('playbtn').firstChild.textContent=playing?'⏸ pause ':'▶ play ';} });
document.getElementById('playbtn').onclick=()=>{playing=!playing; document.getElementById('playbtn').firstChild.textContent=playing?'⏸ pause ':'▶ play ';};
addEventListener('resize',()=>{ camera.aspect=innerWidth/innerHeight; camera.updateProjectionMatrix(); renderer.setSize(innerWidth,innerHeight); const old=sceneRT; sceneRT=makeRT(); old.dispose(); });

window.__V = { THREE, renderer, scene, camera, sun, sceneRT:()=>sceneRT, fsQuad, passMat, SUBJECT, get arc(){return arc;}, set arc(v){arc=v;}, set playing(v){playing=v;}, placeSun, renderFrame }; // TEMP debug handle
applyControls(); requestAnimationFrame(tick);
  </script>
</body></html>
```

- [ ] **Step 2: Verify it loads and renders the lit monitor**

Run: load `http://localhost:8088/prototype-volumetric.html` in the preview; read console (level=error); then via `window.__V` freeze `arc=0.6`, call `__V.placeSun(0.6); __V.renderFrame();` and screenshot.
Expected: ZERO console errors; the screenshot shows the monitor on the ledge, warm-lit by `sun`, with a real shadow on the ledge. (At this stage there is NO volumetric glow yet — passthrough only.)

- [ ] **Step 3: Commit**

```bash
git add prototype-volumetric.html docs/superpowers/plans/2026-06-20-volumetric-intro.md
git commit -m "feat(proto): volumetric intro scaffold — scene + depth RT + passthrough"
```

---

### Task 2: World-position reconstruction debug pass

**Files:**
- Modify: `prototype-volumetric.html` (replace `passMat` fragment shader + add camera-inverse uniforms; add a `MODE` debug toggle)

**Interfaces:**
- Consumes: `sceneRT.depthTexture`, `camera.projectionMatrixInverse`, `camera.matrixWorld`.
- Produces: a fragment shader function `vec3 worldFromDepth(vec2 uv, float rawDepth)` and uniforms `uInvProj` (mat4 = `camera.projectionMatrixInverse`), `uCamWorld` (mat4 = `camera.matrixWorld`), `uCamPos` (vec3). These exact uniform names are reused by Task 4.

- [ ] **Step 1: Replace passMat with a debug material that visualizes reconstructed world position**

Replace the `passMat` definition with:

```js
const passMat = new THREE.ShaderMaterial({
  uniforms: {
    tDiffuse:{value:null}, tDepth:{value:null},
    uInvProj:{value:new THREE.Matrix4()}, uCamWorld:{value:new THREE.Matrix4()}, uCamPos:{value:new THREE.Vector3()},
    uMode:{value:1}, // 1 = debug worldpos, 0 = passthrough
  },
  vertexShader: `varying vec2 vUv; void main(){ vUv=uv; gl_Position=vec4(position.xy,0.0,1.0); }`,
  fragmentShader: `
    varying vec2 vUv;
    uniform sampler2D tDiffuse; uniform sampler2D tDepth;
    uniform mat4 uInvProj; uniform mat4 uCamWorld; uniform vec3 uCamPos; uniform int uMode;
    vec3 worldFromDepth(vec2 uv, float rawDepth){
      // NDC (note three depth texture stores [0,1])
      vec4 ndc = vec4(uv*2.0-1.0, rawDepth*2.0-1.0, 1.0);
      vec4 view = uInvProj * ndc; view /= view.w;        // view space
      vec4 world = uCamWorld * view;                      // world space
      return world.xyz;
    }
    void main(){
      vec3 col = texture2D(tDiffuse, vUv).rgb;
      float d = texture2D(tDepth, vUv).x;
      if (uMode==1){
        if (d >= 1.0){ gl_FragColor=vec4(0.0,0.0,0.0,1.0); return; } // sky / no geometry
        vec3 w = worldFromDepth(vUv, d);
        gl_FragColor = vec4(fract(w*0.2), 1.0);            // banded world-pos viz
        return;
      }
      gl_FragColor = vec4(col, 1.0);
    }`,
  depthTest:false, depthWrite:false,
});
```

- [ ] **Step 2: Feed the camera-inverse uniforms in renderFrame()**

In `renderFrame()`, before `fsQuad.render`, add (after the scene render, the camera matrices are up to date):

```js
  passMat.uniforms.tDepth.value = sceneRT.depthTexture;
  passMat.uniforms.uInvProj.value.copy(camera.projectionMatrixInverse);
  passMat.uniforms.uCamWorld.value.copy(camera.matrixWorld);
  passMat.uniforms.uCamPos.value.copy(camera.position);
```

Also add to `window.__V`: nothing new needed (passMat already exposed).

- [ ] **Step 3: Verify the reconstruction is plausible**

Run: load the page; `__V.placeSun(0.6); __V.renderFrame();` screenshot.
Expected: ZERO errors. The monitor + ledge show smooth banded color gradients (the `fract(world*0.2)` pattern) that are STABLE and follow the surfaces' world geometry (the ledge shows horizontal bands, the monitor shows bands following its faces); the area with no geometry is pure black. If the bands swim with the camera or the monitor reads as flat/noise, the reconstruction matrices are wrong — fix `uInvProj`/`uCamWorld` before proceeding.

- [ ] **Step 4: Commit**

```bash
git add prototype-volumetric.html
git commit -m "feat(proto): world-position reconstruction from depth (debug viz)"
```

---

### Task 3: Shadow-map sampling debug pass

**Files:**
- Modify: `prototype-volumetric.html` (add shadow uniforms + `sampleShadow`, add MODE=2 visualization)

**Interfaces:**
- Consumes: `sun.shadow.map.texture` (the hero light's depth map — non-null only AFTER the first shadowed render, i.e. after `renderFrame()` has run once), `sun.shadow.matrix` (world→shadow uv/depth, already includes the [-1,1]→[0,1] bias in three).
- Produces: fragment function `float sampleShadow(vec3 worldPos)` returning `1.0` lit / `0.0` shadowed, and uniforms `uShadowMap` (sampler2D), `uShadowMatrix` (mat4 = `sun.shadow.matrix`). Reused by Task 4.

- [ ] **Step 1: Add shadow uniforms + sampling, and a MODE=2 viz**

Add to `passMat.uniforms`: `uShadowMap:{value:null}, uShadowMatrix:{value:new THREE.Matrix4()}`.

In the fragment shader, add this function (above `main`):

```glsl
    uniform sampler2D uShadowMap; uniform mat4 uShadowMatrix;
    float sampleShadow(vec3 worldPos){
      vec4 sc = uShadowMatrix * vec4(worldPos, 1.0); sc /= sc.w; // three's matrix → [0,1] uv + depth
      if (sc.x<0.0||sc.x>1.0||sc.y<0.0||sc.y>1.0||sc.z>1.0) return 1.0; // outside the shadow frustum = lit
      float occ = texture2D(uShadowMap, sc.xy).x;                       // stored nearest depth [0,1]
      return (sc.z - 0.0015 > occ) ? 0.0 : 1.0;                          // bias to avoid acne
    }
```

In `main`, add the `uMode==2` branch (after the `uMode==1` block):

```glsl
      if (uMode==2){
        if (d >= 1.0){ gl_FragColor=vec4(0.02,0.0,0.0,1.0); return; }
        vec3 w = worldFromDepth(vUv, d);
        float lit = sampleShadow(w);
        gl_FragColor = vec4(vec3(lit), 1.0);                            // white=lit, black=shadow
        return;
      }
```

- [ ] **Step 2: Feed the shadow uniforms in renderFrame() and default MODE=2**

In `renderFrame()` (after the scene render — `sun.shadow.map` is populated):

```js
  if (sun.shadow.map){ passMat.uniforms.uShadowMap.value = sun.shadow.map.texture; }
  passMat.uniforms.uShadowMatrix.value.copy(sun.shadow.matrix);
```

Set `passMat.uniforms.uMode.value = 2;` once after creating passMat (temporary, to view this task).

- [ ] **Step 3: Verify the shadow mask matches the scene shadow**

Run: load; `__V.placeSun(0.6); __V.renderFrame();` screenshot. Then also probe: via `window.__V`, render and `gl.readPixels` a few points — a point on the lit ledge should read ~white (lit), a point inside the monitor's cast shadow on the ledge should read ~black.
Expected: ZERO errors. The white/black mask matches where the monitor's real shadow falls on the ledge (compare to the lit render from Task 1). If the mask is inverted, flip the comparison; if it's offset/garbage, the `sun.shadow.matrix` or depth compare is wrong — fix before proceeding. **Note:** three only allocates `sun.shadow.map` after the first shadowed render, which Task 1's `renderFrame()` guarantees.

- [ ] **Step 4: Commit**

```bash
git add prototype-volumetric.html
git commit -m "feat(proto): shadow-map sampling in screen space (debug mask)"
```

---

### Task 4: Volumetric raymarch accumulation

**Files:**
- Modify: `prototype-volumetric.html` (add the raymarch loop + uniforms; set MODE=0 to composite over the scene)

**Interfaces:**
- Consumes: `worldFromDepth`, `sampleShadow` (Tasks 2–3), `uCamPos`, scene color.
- Produces: uniforms `uLightColor` (vec3), `uDensity` (float), `uIntensity` (float), `uSteps` (int via float loop bound), `uMaxDist` (float). The final composite output `scene + glow`.

- [ ] **Step 1: Add raymarch uniforms**

Add to `passMat.uniforms`:

```js
  uLightColor:{value:new THREE.Color(WARM)}, uDensity:{value:0.8}, uIntensity:{value:1.0}, uMaxDist:{value:60.0},
```

- [ ] **Step 2: Add the raymarch in main (MODE=0 path = final composite)**

Replace the `uMode==0`/passthrough tail of `main` with the raymarch composite. The full `main` becomes:

```glsl
    void main(){
      vec3 col = texture2D(tDiffuse, vUv).rgb;
      float d = texture2D(tDepth, vUv).x;

      // ray from camera through this pixel, out to the scene hit (or uMaxDist for sky)
      vec3 hit; 
      if (d >= 1.0){ hit = uCamPos + normalize(worldFromDepth(vUv, 0.999) - uCamPos) * uMaxDist; }
      else { hit = worldFromDepth(vUv, d); }
      vec3 ro = uCamPos;
      vec3 rd = hit - ro;
      float marchLen = min(length(rd), uMaxDist);
      rd = normalize(rd);

      const int MAXS = 96;
      float fsteps = 56.0;                              // overridden by uniform below if added
      float stepSize = marchLen / fsteps;
      float accum = 0.0;
      vec3 p = ro;
      for (int i=0;i<MAXS;i++){
        if (float(i) >= fsteps) break;
        p += rd * stepSize;
        float lit = sampleShadow(p);
        accum += lit;
      }
      accum *= stepSize * uDensity;                     // integrate in-scatter
      vec3 glow = uLightColor * accum * uIntensity;
      gl_FragColor = vec4(col + glow, 1.0);
    }
```

(Keep the `worldFromDepth` and `sampleShadow` functions; the `uMode==1/2` debug branches may be left above `main` guarded by `if(false)` or removed — your choice, but the default render path is this composite.)

- [ ] **Step 3: Wire the uniforms and default to composite mode**

In `renderFrame()` add:

```js
  passMat.uniforms.uLightColor.value.set(WARM);
  passMat.uniforms.uDensity.value = +ctrl.density.value;
  passMat.uniforms.uIntensity.value = +ctrl.intensity.value;
```

Remove any `uMode.value = 2` line so the composite path runs.

- [ ] **Step 4: Verify real god-ray beams appear, broken by the silhouette**

Run: load; `__V.placeSun(0.2); __V.renderFrame();` screenshot (silhouette beat — sun low-behind). Then `__V.placeSun(0.55); __V.renderFrame();` screenshot.
Expected: ZERO errors. Warm volumetric BEAMS/shafts are visible radiating from behind the monitor, and they are **occluded by the monitor** — i.e. the monitor casts dark "shadow rays" / God-ray gaps where it blocks the light (the hallmark we've been missing). Brighter where the light is more aligned with the view. If there are no beams, raise the `density`/`intensity` sliders; if it's a flat wash with no shafts, the shadow sampling in the march is not varying — recheck Task 3.

- [ ] **Step 5: Commit**

```bash
git add prototype-volumetric.html
git commit -m "feat(proto): shadow-aware volumetric raymarch — real god-ray beams"
```

---

### Task 5: Quality — bayer dither, phase function, step count, fog falloff

**Files:**
- Modify: `prototype-volumetric.html` (improve the raymarch: dithered start offset, Henyey-Greenstein phase toward the light, distance fog falloff, `uSteps` from the slider)

**Interfaces:**
- Consumes: Task 4 raymarch.
- Produces: uniforms `uSteps` (float), `uLightDir` (vec3, world-space direction FROM the light, i.e. `sun.target - sun.position` normalized), `uG` (float HG anisotropy ~0.6). Adds `bayer4(vec2)` and `hg(float cosT, float g)` GLSL helpers.

- [ ] **Step 1: Add helpers + uniforms**

Add to `passMat.uniforms`: `uSteps:{value:56.0}, uLightDir:{value:new THREE.Vector3()}, uG:{value:0.6}`.

Add above `main`:

```glsl
    uniform float uSteps; uniform vec3 uLightDir; uniform float uG;
    float bayer4(vec2 p){
      // 4x4 ordered dither, returns [0,1)
      int x = int(mod(p.x,4.0)); int y = int(mod(p.y,4.0));
      int idx = x + y*4;
      float m[16];
      m[0]=0.;m[1]=8.;m[2]=2.;m[3]=10.;m[4]=12.;m[5]=4.;m[6]=14.;m[7]=6.;
      m[8]=3.;m[9]=11.;m[10]=1.;m[11]=9.;m[12]=15.;m[13]=7.;m[14]=13.;m[15]=5.;
      float v=0.0; for(int i=0;i<16;i++){ if(i==idx) v=m[i]; }
      return v/16.0;
    }
    float hg(float cosT, float g){
      float g2=g*g; float denom=1.0+g2-2.0*g*cosT;
      return (1.0-g2)/(4.0*3.14159265*pow(max(denom,1e-3),1.5));
    }
```

- [ ] **Step 2: Upgrade the march in main**

Replace the march block (between `rd = normalize(rd);` and `gl_FragColor`) with:

```glsl
      float fsteps = clamp(uSteps, 8.0, 96.0);
      float stepSize = marchLen / fsteps;
      float jitter = bayer4(gl_FragCoord.xy);            // break banding
      float accum = 0.0;
      vec3 p = ro + rd * stepSize * jitter;
      for (int i=0;i<96;i++){
        if (float(i) >= fsteps) break;
        float lit = sampleShadow(p);
        // distance fog falloff so near-camera haze doesn't dominate
        float fog = exp(-length(p - ro) * 0.02);
        accum += lit * fog;
        p += rd * stepSize;
      }
      float phase = hg(dot(rd, normalize(uLightDir)), uG); // forward scatter toward the lamp
      accum *= stepSize * uDensity * (0.4 + 1.6 * phase);
      vec3 glow = uLightColor * accum * uIntensity;
      gl_FragColor = vec4(col + glow, 1.0);
```

- [ ] **Step 3: Wire uSteps + uLightDir in renderFrame()**

```js
  passMat.uniforms.uSteps.value = +ctrl.steps.value;
  passMat.uniforms.uLightDir.value.copy(SUBJECT).sub(sun.position).normalize();
```

- [ ] **Step 4: Verify clean, warm, directional beams with no banding**

Run: load; `__V.placeSun(0.2); __V.renderFrame();` screenshot; try density/intensity/steps sliders via `__V` (set `ctrl` values) and re-render.
Expected: ZERO errors. The beams are now smooth (no concentric step-banding), warm Edison amber, and visibly STRONGER when the view looks toward the lamp (phase), fading with distance. The monitor's silhouette still cleanly breaks the beams. Confirm raising `steps` removes residual banding and raising `density` thickens the haze.

- [ ] **Step 5: Commit**

```bash
git add prototype-volumetric.html
git commit -m "feat(proto): volumetric quality — bayer dither, HG phase, fog falloff"
```

---

### Task 6: Arc choreography + UI

**Files:**
- Modify: `prototype-volumetric.html` (full arc-driven sequence: light arc, volumetric ramp, front-lit reveal, fade; play default on)

**Interfaces:**
- Consumes: `placeSun`, the volumetric uniforms, `renderFrame`.
- Produces: a single `driveArc(a)` that sets sun position/intensity, `uDensity`/`uIntensity` envelopes, and a final fade — called from `tick`. Final state: `arc=0` plays through to `arc=1` (loop) showing silhouette → beams → reveal → settle.

- [ ] **Step 1: Replace placeSun + add the choreography**

Replace `placeSun` and the arc handling with:

```js
const smooth=(x,a,b)=>{const t=Math.min(1,Math.max(0,(x-a)/(b-a)));return t*t*(3-2*t);};
function driveArc(a){
  // lamp arc: behind-low (silhouette) → over → high front (reveal), always aimed at the monitor
  const th = THREE.MathUtils.degToRad(202 + (38-202)*a);
  sun.position.set(SUBJECT.x+1.0, SUBJECT.y + Math.sin(th)*6.5, SUBJECT.z + Math.cos(th)*9);
  sun.target.position.copy(SUBJECT); sun.target.updateMatrixWorld();
  // lamp brightness: weak sunrise → strong; modest peak so the reveal never blows out
  sun.intensity = (0.2 + 0.8*a) * 2.6;
  // volumetric: glows up for the silhouette, peaks mid-arc (beams), thins for the clean reveal
  const up = smooth(a, 0.05, 0.3);
  const front = smooth(a, 0.55, 0.95);
  passMat.uniforms.uDensity.value   = (+ctrl.density.value)   * up * (1.0 - 0.7*front);
  passMat.uniforms.uIntensity.value = (+ctrl.intensity.value) * (0.3 + 0.7*up);
}
```

In `tick`, change the `monitorReady` branch to `if (monitorReady){ driveArc(arc); renderFrame(); }` and in `renderFrame()` REMOVE the lines that set `uDensity`/`uIntensity` from the sliders directly (driveArc now owns them; keep `uLightColor`, `uSteps`, `uLightDir`, the camera + shadow uniforms).

Set defaults `let arc = 0, playing = true` (play through on load).

Also update the `window.__V` debug handle: it currently references `placeSun` (now removed) — replace that property with `driveArc` so the object is `{ THREE, renderer, scene, camera, sun, sceneRT:()=>sceneRT, fsQuad, passMat, SUBJECT, get arc(){return arc;}, set arc(v){arc=v;}, set playing(v){playing=v;}, driveArc, renderFrame }`. (Leaving the stale `placeSun` reference would throw a ReferenceError at module eval.)

- [ ] **Step 2: Verify the full sequence plays**

Run: load; let it play (or scrub via `__V.arc`). Capture frames at `arc` 0.18, 0.5, 0.85 (set `__V.playing=false; __V.arc=0.18; __V.placeSun?` — use `driveArc` through a fresh exposed handle, OR set `__V.arc` and call `__V.renderFrame()` after `driveArc`; expose `driveArc` on `__V`).
Expected: ZERO errors. arc 0.18 = dark, warm beams behind a silhouetted monitor; arc 0.5 = strong volumetric shafts raking past the monitor; arc 0.85 = monitor front-lit/revealed, beams thinned, NOT blown out. The loop reads as silhouette → beams → reveal.

- [ ] **Step 3: Commit**

```bash
git add prototype-volumetric.html
git commit -m "feat(proto): arc choreography — silhouette → volumetric beams → reveal"
```

- [ ] **Step 4: Hand to the user for live judgement**

Surface the URL `http://localhost:8088/prototype-volumetric.html` and the sliders (exposure/density/intensity/steps). The user scrubs the arc and tunes live. Capture their verdict + preferred slider values in this plan file (append a `## Verdict` section) before any integration.

---

## Notes for the implementer

- **Three r152 GLSL is ES 1.00** — use `texture2D`, `gl_FragColor`, `varying`, and constant-indexable loops with a constant `MAXS` bound + a `break` on a uniform float (as written). Do not use dynamic array indexing by a non-const in a way GLSL1 rejects — the `bayer4` helper avoids it with an unrolled loop.
- **DepthTexture requires WebGL2** (default in r152). If `sceneRT.depthTexture` reads as all-1.0, confirm the renderer got a WebGL2 context (`renderer.capabilities.isWebGL2 === true`).
- **`sun.shadow.matrix`** in r152 already maps world→[0,1] uv + depth (it bakes the bias matrix), so `sampleShadow` does NOT apply an extra `*0.5+0.5`. If shadows look offset, this is the first thing to recheck.
- **`sun.shadow.map`** is null until the first shadowed render; never read `.texture` before `renderFrame()` has run once (the code guards this).
- Keep `window.__V` until Task 6 verification is done; it is the orchestrator's probe/freeze handle. (Integration into `js/Intro.js` is a SEPARATE follow-up plan and will remove it.)

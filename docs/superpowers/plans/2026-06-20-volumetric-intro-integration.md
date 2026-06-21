# Volumetric Intro — Main-Scene Integration + Dev Control Panel

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the faked sprite-glow intro with the validated true-volumetric raymarch lighting in the MAIN 3D scene, and add a `?tune`-gated live control panel so the choreography can be tuned in-browser without code round-trips.

**Architecture:** Three pieces. (1) A thin optional post-process **seam in `TV.js`**: only while `introActive`, route the single render call through scene→color+depth render target→fullscreen volumetric composite; otherwise render exactly as today. (2) **`Intro.js` rewritten in place** — keeps all orchestration (beat clock, GSAP timeline, button-flicker, arc math, camera lock, skip/overlay, scene capture/restore) and swaps the lamp technique from faked SpotLight+sprite to a shadow-casting `DirectionalLight` + the byte-ported volumetric pass, driven per-frame by `driveArc(a)`. (3) A new **dev `ControlPanel`** (DOM overlay behind `?tune`) writing to one shared `introConfig` object the intro reads live (instant for envelope params; rebuild+replay for timeline-structure params).

**Tech Stack:** three.js r0.152.2 (importmap, WebGL2), GSAP (window global), no bundler. The validated technique lives in `prototype-volumetric.html` (the canonical source for the shader + `driveArc`).

## Global Constraints

- **Source of truth for the shader + choreography:** `prototype-volumetric.html` in this repo. Byte-port `volMat` (its `passMat` ShaderMaterial, including the rank-2 occMask gate, soft shadow test, exposure rolloff) and `driveArc`/`makeRT`/`setSize` from there. Do NOT re-derive the GLSL. The look it produces is user-approved and must not regress.
- **The single TV render call is `TV.js` inside `_render()` (the `this.renderer.render(this.scene, this.camera)` inside `if (this.camera)`).** It is the SOLE render call (no EffectComposer). The two-pass branch must FULLY own rendering when active — never let the scene draw straight to screen AND composite.
- **Locked product decisions (from the user):**
  - Default ending = **go-dark → reveal in restored default lighting** (current). **Continuity** ("lamp's final warm state becomes the scene") is a **toggle** (`introConfig.dark = false`) that bakes the terminal warm tone into exposure/ambient and DISPOSES the lamp — never persists a shadow-casting DirectionalLight (would break night-mode).
  - CRT/menu boot stays **scroll-gated** (current behavior). Do NOT add auto-boot.
  - Music starts **at sunrise** (current `onStart` beat). No music retiming.
- **CRT texture mapping params must not change:** `repeat(1.7,1.7)`, `offset(-0.64,-0.42)`, `flipY:false` on the Glass screen. Do NOT override Glass to a black `MeshBasicMaterial` like the prototype does — in the main scene Glass carries the live CRT canvas texture and must render normally into the RT. The CRT is OFF (dark) during the intro so it already reads as silhouette; the occMask luma gate keeps glow off the dark screen.
- **Tone-mapping / encoding:** pass-1 renders with the main renderer's CineonToneMapping + sRGBEncoding + exposure into the RT, so `sceneRT.texture` is already tone-mapped+encoded. The fullscreen `volMat` must output a plain `vec4` with NO re-encode/tone-map (it does its own `1-exp(-glow)` rolloff). Do not double-encode.
- **Camera far is 100 in the main scene** (prototype used 400). `worldFromDepth` + the `d>=1` sky branch auto-use the bound camera, BUT `uMaxDist` must be `<= 100` (default ~50). Keep the bayer jitter (mitigates 16-bit depth banding).
- **Frame-1 / hidden-tab / pre-model guards:** the two-pass branch only runs when `introActive && _volPass && _volPass.ready && _sceneRT`; `ready` gates on model-loaded. Replicate the prototype's `if (sun.shadow.map)` null guard before reading the shadow map.
- **RT lifecycle:** allocate the color+depth RT only on `setVolumetricPass(pass)`; dispose RT+depthTexture+fsQuad+volMat on `setVolumetricPass(null)`. Recreate on resize. No permanent VRAM.
- **Three exits must agree:** `_restoreScene` (normal finish), `skip()`, and the app.js error fallback must all call `tv.setVolumetricPass(null)` + dispose, and (for `dark=false`) write the SAME terminal scene state.
- **Cache-busting:** bump `?v=N` together in the `app.js` import, the `TV.js` import, and the `index.html` script tag whenever a module changes (per CLAUDE.md).
- **Dev panel never ships to real users:** gate construction behind a `?tune` (or `?devpanel`) query flag, mirroring the existing `?demo` pattern.
- **The whole tuning system must be trivially removable (one seam, greppable).** Once the look is finalized the panel + live-tuning wiring is dead weight the user wants gone. Architect so deletion is a documented one-step op, NOT surgery threaded through the intro:
  - The panel + its styles live in their OWN file(s): `js/intro-control-panel.js` and a single clearly-delimited CSS block (`/* DEV-TUNE panel start */ … /* DEV-TUNE panel end */`). Removing the panel = delete the file + that CSS block.
  - `app.js` constructs the panel via exactly ONE `?tune`-gated call, tagged `// DEV-TUNE`. Removing it = delete that line.
  - The intro reads a plain `introConfig` object that holds the BAKED defaults and is fully functional with the panel absent — **the production intro path must never call into panel code or depend on it existing.** The panel only mutates `introConfig` (and calls `intro.rebuild()`); if it's gone, the intro just runs on the baked values.
  - Every in-place hook that exists ONLY for tuning (the `rebuild()` plumbing if it has no production use, live-mutation listeners, scrub/replay/copy wiring) is tagged with a greppable `// DEV-TUNE` comment so `grep -rn 'DEV-TUNE' js/` lists everything to strip. Hooks that the production intro genuinely needs (e.g. `driveArc` reading `introConfig`) are NOT tagged — they stay.
  - The continuity `dark` flag stays a normal `introConfig` field; once the user picks a value it's just a baked constant — no toggle UI required at runtime.
- **Verification is VISUAL / framebuffer, done by the orchestrator** (not unit tests), exactly as for the prototype: load the page, freeze beats via a debug handle, screenshot at full viewport + read framebuffer brightness. Each task's "verify" steps are performed by the controller, not the implementer; implementers transcribe + syntax-check + commit.
- **Anchor all control-panel default ranges to the prototype's approved values** (arc, density 1.8 / intensity 2.0 / steps 96 / color #ffb86b), not the older `Intro.js` constants.

---

### Task 1: TV.js render seam + RT lifecycle (invisible — no behavior change)

**Files:**
- Modify: `js/TV.js` (the `_render()` render call; add fields, `makeRT`, `setVolumetricPass`, resize hook)

**Interfaces:**
- Produces: `tv.setVolumetricPass(passObj | null)` where `passObj = { fsQuad, ready:boolean, updateUniforms(sceneRT, camera) }`. While `introActive && pass && pass.ready && tv._sceneRT`, `_render` does the two-pass; else unchanged. `tv._sceneRT` (WebGLRenderTarget with `.depthTexture`) is created on a non-null setter call, disposed on a null call, and recreated on resize.
- Consumes: nothing from later tasks.

- [ ] **Step 1: Add nullable fields + `makeRT` helper.** In `TV.js`, near the renderer setup, add `this._sceneRT = null; this._volPass = null;` and a method `makeVolRT(w,h)` that returns `new THREE.WebGLRenderTarget(w,h,{minFilter:THREE.LinearFilter,magFilter:THREE.LinearFilter})` with `rt.depthTexture = new THREE.DepthTexture(w,h); rt.depthTexture.type = THREE.UnsignedShortType;` (mirror `prototype-volumetric.html` makeRT). Size to the renderer drawing buffer (`this.sizes.width * pixelRatio`, height likewise) — match `renderer.getContext().drawingBufferWidth/Height`.

- [ ] **Step 2: Add `setVolumetricPass(pass)`.** `pass` non-null → store `this._volPass = pass`, allocate `this._sceneRT = this.makeVolRT(...)` at current drawing-buffer size. `pass` null → dispose `this._sceneRT` (`.depthTexture.dispose(); .dispose()`) and null both fields. Idempotent.

- [ ] **Step 3: Two-pass branch in `_render`.** Replace the single `this.renderer.render(this.scene, this.camera)` (inside `if (this.camera)`) with:
```js
if (this.introActive && this._volPass && this._volPass.ready && this._sceneRT) {
  this.renderer.setRenderTarget(this._sceneRT);
  this.renderer.clear();
  this.renderer.render(this.scene, this.camera);
  this._volPass.updateUniforms(this._sceneRT, this.camera);
  this.renderer.setRenderTarget(null);
  this._volPass.fsQuad.render(this.renderer);
} else {
  this.renderer.render(this.scene, this.camera);
}
```
Keep the CRT texture upload and `_renderCallbacks` BEFORE this (they already run pre-render — Intro's per-frame uniform writes happen there). Keep `_setLabelPosition()` / `rotateCamera()` after, unchanged.

- [ ] **Step 4: Resize hook.** In `TV.js` `resize()`, after the renderer is resized: `if (this._sceneRT) { this._sceneRT.depthTexture.dispose(); this._sceneRT.dispose(); this._sceneRT = this.makeVolRT(...); }`.

- [ ] **Step 5: Cache-bust + commit.** Bump the `TV.js` import `?v` in `app.js` and `index.html` together. Verify (orchestrator): with no pass set, the page renders byte-identically to before (no `introActive`, `_volPass` null → `else` branch). Commit `js/TV.js`, `js/app.js`, `index.html`.

---

### Task 2: Port the volumetric pass module (volMat + pass object)

**Files:**
- Create: `js/volumetric-pass.js`
- Test: orchestrator visual (static frame in main scene)

**Interfaces:**
- Produces: `createVolumetricPass(THREE)` → `{ fsQuad, volMat, ready, sun, group, setReady(b), updateUniforms(sceneRT, camera), driveArc(a, cfg), dispose() }`. `sun` is a `THREE.DirectionalLight` (shadow-casting, ortho frustum from the prototype, `uMaxDist<=100`). `group` holds the light + target for adding to the scene. `fsQuad` is `new FullScreenQuad(volMat)`.
- Consumes: `prototype-volumetric.html` shader + driveArc verbatim.

- [ ] **Step 1: Byte-port `volMat`.** Copy the prototype's `passMat` ShaderMaterial (uniforms + vertex + fragment, INCLUDING the soft shadow test, the rank-2 `occMask`/`foreground` gate, the `1-exp(-glow)` rolloff). Import `FullScreenQuad` from `three/addons/postprocessing/Pass.js`. Set `uMaxDist` default 50.

- [ ] **Step 2: Build the lamp.** `sun = new THREE.DirectionalLight(0xffb86b, 0)`, `castShadow`, `shadow.mapSize 2048`, ortho `left/right/top/bottom = -7..7`, `near 1 far 120`, `bias -0.0005`, `normalBias 0.04`. `group.add(sun, sun.target)`.

- [ ] **Step 3: `updateUniforms(sceneRT, camera)`** — copy the prototype's `renderFrame` uniform writes (tDiffuse/tDepth, uInvProj=camera.projectionMatrixInverse, uCamWorld=camera.matrixWorld, uCamPos, `if (sun.shadow.map) uShadowMap`, uShadowMatrix=sun.shadow.matrix, uLightDir=(SUBJECT−sun.position).normalize()). SUBJECT passed in or matched to the scene's monitor center.

- [ ] **Step 4: `driveArc(a, cfg)`** — port the prototype's `driveArc`: lamp arc angle/position, `sun.intensity` envelope, `volMat.uDensity/uIntensity` envelopes, `sun.color` + `uLightColor` from `cfg.lamp.color`, reading multipliers from `cfg` (density/intensity/steps/maxDist). `setReady(b)` flips `ready`.

- [ ] **Step 5: `dispose()`** — dispose volMat, fsQuad, the depth/shadow resources; remove `group` from its parent.

- [ ] **Step 6: Verify + commit.** Orchestrator: a throwaway harness (or the Task-3 stub) renders a STATIC frame (`a` fixed ~0.5) of the MAIN scene through this pass — confirm silhouette + god-ray + ledge shadow render with the live-CRT Glass (NOT black). Commit `js/volumetric-pass.js`.

---

### Task 3: Rewrite Intro.js to drive the volumetric pass

**Files:**
- Modify: `js/Intro.js` (swap lamp technique; keep orchestration), `js/app.js` (import `?v` bump)

**Interfaces:**
- Consumes: `createVolumetricPass` (Task 2), `tv.setVolumetricPass` (Task 1). Keeps the EXACT public surface `app.js` expects: `new Intro(tv, {wallSign, overlay})`, `onStart`/`onSoundRequest`/`onReveal`, `skip()`, `play()→Promise`.
- Produces: the working volumetric intro on the existing beat timeline.

- [ ] **Step 1: Build the pass in `_build`.** Construct `createVolumetricPass(THREE)`, add its `group` to `tv.getScene()`, call `tv.setVolumetricPass(pass)`, `pass.setReady(true)` once the model is present. Keep the existing scene-capture (`_restore`), camera lock, `introActive=true`, overlay/bars, button-flicker setup.

- [ ] **Step 2: Drive per-frame.** In the existing `onRender` tick, call `pass.driveArc(this._a, this.config)` (where `this._a` is the GSAP-tweened arc value). Remove the old `_placeSun` SpotLight positioning in favor of `driveArc` (or have `driveArc` reuse the arc constants).

- [ ] **Step 3: Keep the GSAP timeline** (beats, button-flicker, the `a` 0→1 tween, sunrise/reveal). Music `onStart` stays at the sunrise beat (locked decision). The exposure ramp stays as pass-1 exposure for now.

- [ ] **Step 4: Teardown.** In `_restoreScene` AND `skip()` AND verify the app.js error fallback: call `tv.setVolumetricPass(null)` + `pass.dispose()` + remove `group`. `introActive` clears as today. Three exits identical.

- [ ] **Step 5: Cache-bust + commit.** Bump `Intro.js`/`app.js`/`index.html` `?v`. Orchestrator verify: full intro plays in the main scene (silhouette → beams → reveal), skip works, no console errors, teardown leaves the scene normal. Commit.

---

### Task 4: Strip the fakes

**Files:**
- Modify: `js/Intro.js`

- [ ] **Step 1: Remove** `_sunGlow` (additive Sprite), `_radialTexture`, and the `_tick` sprite orbit/scale/opacity block. The real beam supplies the silhouette glow.
- [ ] **Step 2: Remove** the bezel roughness-matte hack (the Rubber/Cube006 roughness mutation + its restore) — the true shadow-aware shaft removes the need.
- [ ] **Step 3: Decide fog role** — the old black `FogExp2` that hid the void: keep only if it still helps the silhouette; otherwise remove (the volumetric renders its own atmosphere). Orchestrator judges visually.
- [ ] **Step 4: Verify + commit.** Confirm no regression (the beam alone carries the look). Commit `js/Intro.js`.

---

### Task 5: The shared `introConfig` object

**Files:**
- Modify: `js/app.js` (own `introConfig`, pass into `Intro`), `js/Intro.js` (read it for timeline build + driveArc + flicker)

**Interfaces:**
- Produces: a single `introConfig` (shape below) read by the timeline builder AND `driveArc`/`_addButtonFlicker`. `intro.rebuild()` kills + rebuilds the GSAP timeline from `introConfig` and replays.
```js
introConfig = {
  flicker: { type:'struggle', keyframes:[[t,f],...], catchAt:1.12, catchDur:0.32 },
  beats:   { POWER, SUNRISE, ARC_START, ARC_DUR, FADE_START, FADE_DUR, BLACK, REVEAL_DUR, END },
  lamp:    { initialSpeed, initialIntensity, midSpeed, midIntensity, finalIntensity, color:'#ffb86b' },
  vol:     { density:1.8, intensity:2.0, steps:96, maxDist:50, exposure },
  dark:    true,
  music:   { startAt:'SUNRISE' },   // locked
  signReveal:'at_reveal',
}
```

- [ ] **Step 1:** Move the hardcoded BEAT table + flicker keyframes + lamp/vol constants into `introConfig` (app.js owns it, default values = prototype-approved).
- [ ] **Step 2:** `Intro` reads `introConfig` when building the timeline and live each frame in `driveArc`/flicker. Add `intro.rebuild()`.
- [ ] **Step 3:** Verify (editing `introConfig` before `play()` changes the intro) + commit.

---

### Task 6: Dev control panel (`?tune`)

**Files:**
- Create: `js/intro-control-panel.js`
- Modify: `js/app.js` (construct behind `?tune`), `css/styles.css` (panel styles), `index.html` (`?v` bump)

**Interfaces:**
- Consumes: `introConfig` (Task 5), `intro.rebuild()`, `pass.driveArc`. Produces a DOM overlay; live sliders apply via `driveArc`, structural edits call `intro.rebuild()`.

- [ ] **Step 1:** Build the panel DOM (grouped: Button / Lamp / Volumetric / Flow & timing / Utility) per the control spec. Each control writes to `introConfig`.
- [ ] **Step 2:** Live-vs-rebuild routing: lamp intensity/color, vol density/intensity/steps/maxDist/exposure → live; flicker type/length, beat durations, dark-toggle, music/sign timing → `rebuild()`.
- [ ] **Step 3:** Utility controls — **Replay** (rebuild+play, no reload), **Scrub arc** (pause timeline, set `_a` directly), **Copy settings → JSON** (serialize `introConfig` to clipboard).
- [ ] **Step 4:** Gate construction behind `?tune` only (mirror `?demo`). Never built otherwise. The construction call in `app.js` is a SINGLE line tagged `// DEV-TUNE`. All panel DOM/JS lives in `js/intro-control-panel.js`; all panel CSS lives in one `/* DEV-TUNE panel start */ … /* DEV-TUNE panel end */` block in `css/styles.css`. The intro must not import or reference the panel — data flows one way: panel → `introConfig` / `intro.rebuild()`.
- [ ] **Step 5:** Tag every tuning-only in-place hook added to `Intro.js`/`app.js` with `// DEV-TUNE` (live-mutation listeners, scrub/replay/copy plumbing, the `rebuild()` method if it has no production caller). Confirm `grep -rn 'DEV-TUNE' js/ css/` lists the panel call + CSS markers + every removable hook, and that NONE of them are on the production intro path.
- [ ] **Step 6:** Verify (orchestrator drives sliders, confirms live + rebuild paths, AND confirms loading WITHOUT `?tune` runs the intro identically on baked `introConfig`) + commit.

---

### Task 7: Continuity toggle (`dark = false`)

**Files:**
- Modify: `js/Intro.js`, `js/app.js` (error-fallback parity), `js/TV.js` (only if seeding lights from terminal values)

- [ ] **Step 1:** When `introConfig.dark === false`: skip the fade-to-black tweens; hold the lamp's terminal warm state at `a=1`.
- [ ] **Step 2:** In `_restoreScene` for `dark=false`: do NOT reapply captured exposure/ambient/point/fog; instead BAKE the terminal warm tone into a slightly warm ambient + lifted point intensity + the intro's terminal `toneMappingExposure` (target ~3.0 so night-mode's exposure<1 detection still works) + a consistent clear/fog color; THEN `tv.setVolumetricPass(null)` + dispose the lamp.
- [ ] **Step 3:** Make `skip()` and the app.js error fallback write the SAME terminal state for `dark=false` (three-exit parity). Keep night-mode + the panel exposure slider mutually exclusive while `introActive`.
- [ ] **Step 4:** Verify both toggle states (dark on/off) end cleanly, night-mode toggles sanely afterward. Commit.

---

### Task 8: Timing tunables + perf/gating pass

**Files:**
- Modify: `js/Intro.js`, `js/app.js`, `js/intro-control-panel.js`

- [ ] **Step 1:** Parameterize the wall-sign reveal timing (`introConfig.signReveal`) at the `wallSign.flickerOn()` call site. (Music stays at sunrise per locked decision; CRT boot stays scroll-gated — no auto-boot hook.)
- [ ] **Step 2:** Perf: on a coarse pointer / small viewport, default `vol.steps` lower (e.g. 48) and/or allocate the RT at half drawing-buffer resolution with upsample. Keep `prefers-reduced-motion` skipping the intro (existing app.js gate).
- [ ] **Step 3:** Production gating: confirm the panel is excluded unless `?tune`; smoke-test that permalink / `?demo` / skip-intro paths still bypass the intro. Final cache-bust bump.
- [ ] **Step 4:** Verify + commit.

---

### Task 9: Verdict capture + one-step tuning-system removal

**Files:**
- Modify: this plan (append `## Verdict` + the removal procedure), `js/app.js`; delete `js/intro-control-panel.js`, `prototype-volumetric.html`, and the panel CSS block — only after the user blesses the look and says to strip tuning.

- [ ] **Step 1:** Surface the integrated intro + `?tune` panel to the user; capture their preferred `introConfig` (the Copy-settings JSON) and bake it as the default `introConfig` literal in `app.js`. Collapse the `dark` flag to the chosen constant.
- [ ] **Step 2:** Record the chosen settings + the exact removal steps in a `## Verdict` section here.
- [ ] **Step 3 (only on the user's "strip tuning" go):** Execute the one-step removal: `grep -rn 'DEV-TUNE' js/ css/` to list every removable hook; delete `js/intro-control-panel.js`, the one `// DEV-TUNE` panel-construction line in `app.js`, the `/* DEV-TUNE panel start/end */` CSS block, and each `// DEV-TUNE`-tagged hook; delete `prototype-volumetric.html` (throwaway). Verify the intro still plays identically on the baked `introConfig` with zero tuning code remaining (`grep` returns nothing), then commit.

# HLE.io Site Mirror - Analysis Report

## Overview

This repo contains a mirror of **hle.io** captured via `wget`, plus manually downloaded 3D assets. The site is a portfolio/landing page for HLE, a talent and content company. The main visual feature is an interactive 3D retro TV set rendered with Three.js.

---

## Repo Structure

```
threejs_box_design_dmv/
├── REPORT.md                          # This file
└── hle_mirror/
    ├── TV_plugin_extracted.js         # Cleaned-up TV.js plugin (the core 3D engine)
    └── hle.io/
        ├── index.html                 # Landing page (SSR'd Nuxt HTML)
        ├── about.html
        ├── contacts.html
        ├── privacy-policy.html
        ├── terms-of-use.html
        ├── manifest.json
        ├── favicon.ico / *.png        # Favicons and app icons
        ├── img/
        │   ├── frame.png
        │   └── logo-white.svg
        ├── models/
        │   ├── tv1.glb                # 3D GLTF model of the TV (Draco-compressed, 2.2MB)
        │   └── tv_square.mp4          # Looping video texture for TV screen
        ├── scripts/
        │   └── draco/
        │       ├── draco_decoder.js
        │       ├── draco_decoder.wasm
        │       └── draco_wasm_wrapper.js
        └── _nuxt/
            ├── runtime.js             # Webpack runtime
            ├── app.js                 # Main app bundle (8.8MB) - contains all Vue components
            ├── manifest.cb3bf96e.json
            ├── commons/
            │   └── app.js             # Shared polyfills/utilities
            ├── vendors/
            │   └── app.js             # Third-party libs: Three.js, GSAP, PIXI, Vue, etc. (12MB)
            ├── pages/
            │   ├── index.js           # Landing page route chunk
            │   ├── about.js
            │   ├── contacts.js
            │   ├── privacy-policy.js
            │   └── terms-of-use.js
            └── assets/
                └── fonts/
                    └── SupplyFree/
                        ├── PPSupplyMono-Regular.otf
                        ├── PPSupplyMono-Ultralight.otf
                        ├── PPSupplySans-Regular.otf
                        └── PPSupplySans-Ultralight.otf
```

---

## Running Locally

The mirror is a static site. **You cannot just open `index.html` in a browser** because:
- The Nuxt JS bundles use absolute paths (`/_nuxt/...`, `/models/...`, `/scripts/...`)
- The video texture and GLTF model need to be served over HTTP (CORS)

### Quick Local Server

From the `hle_mirror/hle.io/` directory, run any static server:

```bash
# Option 1: Python
cd hle_mirror/hle.io
python3 -m http.server 8080

# Option 2: Node (npx, no install needed)
cd hle_mirror/hle.io
npx serve -p 8080

# Option 3: PHP
cd hle_mirror/hle.io
php -S localhost:8080
```

Then open `http://localhost:8080` in a browser.

### Known Limitations

- The site was built with **Nuxt.js (Vue SSR)**. The initial HTML is server-rendered, but full interactivity depends on client-side hydration via the JS bundles.
- The `webpack://` eval'd modules inside `_nuxt/app.js` contain dev-mode source maps. The code is readable but wrapped in webpack boilerplate.
- API calls to `https://api.hle.io` (for FAQ data, project listings) will fail locally. The SSR-rendered HTML already contains this data inline via `window.__NUXT__`, so the landing page content still displays.
- Google Analytics (`G-8L9JVNYCM7`) will fire but can be ignored.

---

## 3D Scene Technical Breakdown

### Tech Stack

| Layer | Technology |
|-------|-----------|
| Framework | Nuxt.js 2 (Vue 2 SSR) |
| 3D Engine | **Three.js** (r-series, bundled in `vendors/app.js`) |
| Animation | **GSAP** (GreenSock) + ScrollTrigger |
| 3D Model Format | GLTF 2.0 with **Draco** compression |
| Video Texture | HTML5 `<video>` element -> `VideoTexture` |

### Key Source Files (inside `_nuxt/app.js`)

| Component | Webpack Module Path | Purpose |
|-----------|-------------------|---------|
| **TV Plugin** | `./plugins/TV.js` | Core 3D engine class - scene, camera, model loading, rendering |
| **StartScreenCanvas** | `./components/main-page/StartScreenCanvas.vue` | Vue wrapper - mounts TV, handles events |
| **StartScreen** | `./components/main-page/StartScreen.vue` | Layout wrapper with scroll sections |
| **StartScreenFooter** | `./components/main-page/StartScreenFooter.vue` | Footer overlay on landing |
| **StartScreenDarkSection** | `./components/main-page/StartScreenDarkSection.vue` | Dark-themed scroll section |
| **NightmodeLabel** | `./components/NightmodelLabel.vue` | Day/night toggle label (projected to 2D from 3D) |

A cleaned-up extraction of the TV plugin is at: **`hle_mirror/TV_plugin_extracted.js`**

### TV.js - The 3D Engine

#### Constructor (`new TV(parentDOM, label, video)`)

- Creates a `WebGLRenderer` with alpha, antialias, `CineonToneMapping`
- Sets pixel ratio to `min(devicePixelRatio, 2)`
- Creates a `VideoTexture` from the `<video>` element, with custom repeat/offset:
  - `repeat.set(1.7, 1.7)`, `offset.x = -0.64`, `offset.y = -0.42`, `flipY = false`
- Initializes a `Scene` with `Fog(0x7a7a7a, 27, 29)`
- Sets up a `Raycaster` for click detection
- Configures `GLTFLoader` with `DRACOLoader` (decoder path: `/scripts/draco/`)

#### Model Structure (`models/tv1.glb`)

The GLTF model contains these named meshes:

| Object Name | Role | Material Override |
|-------------|------|------------------|
| `Glass` | TV screen surface | Replaced with `MeshBasicMaterial({ map: videoTexture })` |
| `Cube001` | TV body / power button / toggle trigger | Replaced with `MeshBasicMaterial({ color: 0x000000 })` |
| `Plane` | Ground/base plane | Uses original GLTF material |

An invisible `BoxBufferGeometry(0.9, 1.8, 1.8)` trigger box is added at `(-1.3, -1.7, 2)` for raycasting click detection on the power button.

#### Camera

- `PerspectiveCamera(45, aspect, 0.1, 100)`
- Start position: `(0, -0.5, 20)` — far away
- End position: `(0, 0.5, 3.6)` — close-up
- Always looks at `(0, 0.5, 0)`
- **Mouse parallax**: camera.x/y offset based on normalized mouse position, scaled by `(1 - scrollProgress)` so parallax fades as you scroll in

#### Lights

- `AmbientLight(0xffffff, 0.5)`
- `PointLight(0xffffff, 0.5)` at position `(0, 3, 0.5)`

#### Scroll Animation

Uses GSAP ScrollTrigger on `.start-screen-wrapper`:
- `progress` goes from 0 to 1 as user scrolls
- Camera z interpolates from 20 to 3.6 via: `z = (1 - progress) * 20 + 3.6`
- At `progress > 0.99`, emits `animationEnd` event (triggers loader transition)

#### Night Mode Toggle

Clicking the TV trigger box:
1. Toggles `toneMappingExposure` between 3.0 (day) and 0.6 (night) via GSAP tween
2. Swaps fog color: `0x7a7a7a` (light) / `0x454546` (dark)
3. Slides the trigger element's x position (0 or 0.45)
4. Updates Vuex store (`toggleNightMode` mutation)

#### Render Loop

```
_render() -> renderer.render() -> _setLabelPosition() -> rotateCamera() -> requestAnimationFrame()
```

The `NightmodeLabel` DOM element is positioned by projecting the 3D trigger position to 2D screen coords every frame.

---

## CSS / Design System

### CSS Variables (from `:root`)

```css
--font-mono-regular: "PPSupplyMonoRegular"
--font-mono-ultralight: "PPSupplyMonoUltralight"
--font-sans-regular: "PPSupplySansRegular"
--font-sans-ultralight: "PPSupplySansUltralight"
--color-light: #ffffff
--color-dark: #101011
--color-gray: #CBCBCB
--color-dark-gray: #bbbbbb
--color-dark-blue: #141334
--color-accent: #32A4C3
--color-error: #FD4E28
--transition: 0.5s ease-in-out
--container-padding: 11.7rem  (responsive breakpoints down to 4.27vw on mobile)
```

### Layout

- Fixed header: logo center, nav left, controls right
- Canvas wrapper: `position: absolute; width: 100%; height: 100%` (fills viewport)
- Night mode label: `position: fixed; left: 50%; top: 50%` (then offset via JS 3D projection)
- All CSS is inlined in the HTML `<style>` tags (no external CSS files)

---

## How to Edit / Build On This

### If you want to recreate the 3D scene standalone (recommended):

1. Use `models/tv1.glb` and `models/tv_square.mp4` as-is
2. Reference `TV_plugin_extracted.js` for the exact Three.js setup
3. Install Three.js and GSAP in a fresh project:
   ```bash
   npm init -y
   npm install three gsap
   ```
4. Recreate the TV class using the extracted code as reference

### If you want to modify the existing mirror:

1. The JS bundles are webpack eval'd — not practical to edit directly
2. Better approach: extract the specific component logic (already done for TV.js) and rebuild
3. The HTML pages can be edited directly for layout/styling changes
4. Static assets (model, video, fonts, images) can be swapped directly

### If you want to extract more components:

The webpack bundles use `eval()` with source maps. To extract any module:

```javascript
// Node.js script to extract a module from app.js
const fs = require('fs');
const content = fs.readFileSync('hle.io/_nuxt/app.js', 'utf-8');
const lines = content.split('\n');

// Find the line number of your target module, then:
const line = lines[TARGET_LINE_NUMBER];
const evalMatch = line.match(/eval\("(.*)"\);?$/);
let code = evalMatch[1]
  .replace(/\\n/g, '\n')
  .replace(/\\t/g, '\t')
  .replace(/\\"/g, '"')
  .split('//# sourceURL=')[0];
fs.writeFileSync('output.js', code);
```

### Key Module Locations in `_nuxt/app.js`

| Line | Module |
|------|--------|
| ~3388 | StartScreenCanvas.vue (component wrapper) |
| ~4828 | StartScreenCanvas.vue script (Vue component logic) |
| ~6545 | StartScreenCanvas.vue template (render function) |
| ~7507 | **plugins/TV.js** (3D engine - the important one) |

---

## Gotchas for Future Agents

- The site uses **Three.js**, not PIXI.js. PIXI appears in `vendors/app.js` but is unused on the landing page.
- The GLTF model is **Draco-compressed** — you must include the Draco decoder scripts or use an uncompressed version.
- The `lerp` function in TV.js has a bug: `return (1 - t) * a + b` should be `(1 - t) * a + t * b`. The effect still works because of how it's called, but be aware if reusing.
- Video autoplay requires user interaction on mobile — the code handles this with a click event listener fallback.
- The `$st` in Vue components refers to GSAP ScrollTrigger (injected as a Nuxt plugin).
- The `$gsap` in Vue components refers to the GSAP core (also a Nuxt plugin).

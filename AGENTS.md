# Agent Reference — DMV Codebase

Terse docs for agents. File-by-file, function-by-function.

---

## File Map

```
index.html          → HTML shell. No logic. Loads CSS, importmap, GSAP CDNs, then js/app.js
css/styles.css      → All styles. CSS grid header/footer, toggle, fonts, layout
js/app.js           → Entry point. Inits TV + CardPoster, wires events, scroll, sound, clock
js/TV.js            → 3D scene. Loads GLTF model, manages camera/lights/renderer, night mode
js/CRTTerminal.js   → Canvas2D CRT terminal. Boot sequence, form input, color schemes
js/CardPoster.js    → 3D plane with CanvasTexture. Draws identity card, fades in on completion
hle_mirror/         → Static assets only (fonts, logo SVG, tv1.glb model). Nothing executable.
```

---

## js/app.js (entry point, 99 lines)

Top-level await module. No exports.

- **Lines 1-5**: Imports TV, CardPoster. Gets gsap/ScrollTrigger from window globals.
- **Lines 7-11**: DOM refs: `canvasWrapper`, `modeLabel`, `startScreen`, `hiddenInput`.
- **Lines 13-15**: Creates `TV(container, label)`, calls `await tv.init()`.
- **Lines 17-21**: Creates `CardPoster(tv.getScene())`. Wires `tv.crt.onComplete` → `cardPoster.show(data)`.
- **Lines 23-33**: Sound toggle. Creates `Audio('audio/music.mp3')`, loop=true. Click toggles play/pause, adds `.active` class to button.
- **Lines 35-46**: Clock. Updates `#clockEl` every 10s. Format: `HH : MM am/pm`.
- **Lines 48-59**: GSAP ScrollTrigger on `#scroller` → `.start-screen-wrapper`. Progress 0-1 drives `tv.animateCameraPosition(progress)`. Capped at 0.95.
- **Lines 61-76**: Event listeners: mousemove → parallax, click → raycaster night-mode toggle OR focus hidden input, interval → auto-focus when CRT becomes interactive.
- **Lines 88-96**: Keydown handler. Routes to `tv.crt.handleKey()`. Handles Enter, Backspace, printable chars. Ignores ctrl/meta.
- **Line 99**: Resize handler → `tv.resize()`.

**Key wiring**: `tv.crt.onComplete = (data) => cardPoster.show(data)` — this is the only connection between form completion and the card appearing.

---

## js/TV.js (261 lines)

Exports: `class TV`

### Constructor(parentDOM, label)
- Creates CRTTerminal(1024, 1024) and CanvasTexture from its canvas.
- **Critical texture params**: `repeat(1.7, 1.7)`, `offset(-0.64, -0.42)`, `flipY=false`. Do not change these — they map the CRT canvas onto the TV screen mesh correctly.
- Creates WebGLRenderer (alpha, antialias, CineonToneMapping, exposure=3.0).
- Fog: day=`0x7a7a7a`, night=`0x454546`.
- Camera start: `(0, -0.5, 20)`.
- Uses CDN Draco decoder for GLTF loading.

### Key methods

| Method | What it does |
|--------|-------------|
| `init()` | Loads model, creates camera+lights, starts render loop |
| `loadModel()` | Loads `hle_mirror/hle.io/models/tv1.glb`. Named meshes: `Glass` (screen) → gets CRT texture, `Cube001` (button) → gets colored material. Invisible trigger box at `(-1.41, -1.71, 1.66)` for raycasting |
| `getScene()` | Returns `this.scene` — used by CardPoster to add its mesh |
| `animateCameraPosition(progress)` | 0-1 float. At >0.6 boots CRT. At >0.99 fires animationEnd callbacks |
| `rotateCamera()` | Called every frame. Lerps camera toward mouse NDC. Parallax fades with progress. Close-up position: `z=3.6, y=0.5` |
| `toggleNightModeTV()` | Toggles exposure (3.0↔0.6), fog color, button color (green↔orange), CRT color scheme |
| `getIntersects()` | Raycasts mouse against trigger box. Returns `['button']` or `['none']` |
| `_render()` | RAF loop. Updates CRT, marks texture dirty, renders scene, updates label position, rotates camera |
| `_setLabelPosition()` | Projects fakeTrigger 3D position to 2D screen coords, sets CSS transform on label element |
| `resize()` | Updates sizes from parent bounding rect, updates renderer and camera aspect |

### Night mode state
Toggled by checking `renderer.toneMappingExposure < 1`. Sets `this.isNightMode` boolean. Drives: fog color, clear color, GSAP tween on exposure, trigger element x-position animation, CRT color scheme, button material color.

---

## js/CRTTerminal.js (359 lines)

Exports: `class CRTTerminal`

Pure Canvas2D — no Three.js dependency. Creates an offscreen canvas used as texture by TV.

### Constructor(width, height)
- Default 1024x1024.
- Defines two color palettes: `green` and `orange` (stored in `this.palettes`).
- Starts with green scheme.
- 5 form fields: userName, agentName, email, type, orgName.
- Boot sequence: 15 lines of ASCII art + text stored in `this.bootLines`.

### Boot phases (this.bootPhase)
```
0 = off (black screen)
1 = flickering (random green flashes, ~8 flicker cycles)
2 = booting (typing boot lines one by one)
3 = (unused)
4 = form active (input fields, cursor blinking)
5 = processing (progress bar 0→100%)
6 = done (certificate issued, onComplete fires)
```

### Key methods

| Method | What it does |
|--------|-------------|
| `turnOn()` | Sets bootPhase=1, starts flicker sequence |
| `setColorScheme(name)` | `'green'` or `'orange'`. Swaps all color properties. Remaps colors on existing lines and bootLines arrays in-place |
| `handleKey(key)` | Routes keyboard input. Enter advances field (skips orgName if type=individual). Backspace deletes. Printable chars append. When all fields done → `startProcessing()` |
| `getFormData()` | Returns `{userName, agentName, email, type, orgName}` object |
| `update()` | Called every frame by TV._render(). Advances boot state machine, typing animation, cursor blink. Calls `draw()` |
| `draw()` | Renders entire CRT canvas: background, glow, text lines with typewriter reveal, active input + cursor, progress bar, scanlines, vignette, noise |
| `startProcessing()` | Sets bootPhase=5, adds "Processing..." line, starts progress counter |
| `drawScanlines()` | Horizontal lines every 3px + rolling scanline band |
| `drawVignette()` | Radial gradient darkening edges |

### Completion flow
When `processProgress >= 100`: bootPhase→6, adds certificate lines, calls `this.onComplete(this.getFormData())`. The callback is set externally by app.js.

### Color scheme details
```
green:  bg=#0a0d0a  text=#33ff88  dim=#1a5a3a  header=#88ffcc  flicker=51,255,136
orange: bg=#0d0908  text=#ffaa33  dim=#cc8844  header=#ffdd88  flicker=255,170,51
```
`flickerRGB` is used in template literals for all `rgba()` calls (glow, scanlines, noise).

---

## js/CardPoster.js (119 lines)

Exports: `class CardPoster`

### Constructor(scene)
- Creates 512x320 offscreen canvas.
- Creates PlaneGeometry sized to card aspect ratio (height=2.0 world units).
- Material: MeshBasicMaterial, transparent, opacity=0, DoubleSide.
- Position: `(4, 1, -0.5)`, rotation.y = `-0.2`.
- Starts invisible (`mesh.visible = false`).

### Methods

| Method | What it does |
|--------|-------------|
| `show(formData)` | Draws card, sets texture dirty, makes mesh visible, GSAP fades opacity 0→1 over 1.2s |
| `drawCard(data)` | Canvas2D drawing: dark bg, double border (green), header "DMV VERIFICATION CERTIFICATE", 5 labeled fields, serial number, scanline overlay |

Card colors are hardcoded green scheme. Does not respond to night mode (could be extended).

---

## css/styles.css (199 lines)

- Base: `html { font-size: 62.5% }` → 1rem = 10px.
- `.p2` class: 2.4rem (24px) mono uppercase. Used on most UI text.
- Header/footer: CSS grid 3-col (`1fr auto 1fr`), fixed position, z-index 100, pointer-events none (children re-enable).
- `.header-brand__title`: 3.2rem (32px).
- Toggle: 4rem x 2rem track, 1.2rem thumb, `.active` shifts thumb 1.8rem right.
- Night mode label: positioned by JS (fixed left:50% top:50% + transform). Arrow SVG + text at flex-end.
- Container padding: responsive from 11.7rem (1920+) down to 4.27vw (mobile).

---

## index.html (73 lines)

HTML shell only. Key structure:
```
#scroller (overflow-y:auto, 100vh)
  .start-screen-wrapper (300vh — drives scroll progress)
    .start-screen (sticky, 100vh)
      #canvasWrapper (absolute full — TV renders here)
        #modeLabel (fixed, positioned by JS — arrow + "Switch Day 'N' Night")
      header.start-header (fixed grid — brand/logo/sound)
      footer.start-screen__footer (fixed grid — tagline/scroll/clock)
#hiddenInput (off-screen input for mobile keyboard capture)
```

External deps loaded before module:
- importmap: Three.js 0.152.2 + addons from jsdelivr CDN
- GSAP 3.12.2 core + ScrollTrigger from jsdelivr CDN (global scripts)
- `js/app.js` as `type="module"`

---

## Static Assets (hle_mirror/)

| Path | Used by | Purpose |
|------|---------|---------|
| `hle.io/models/tv1.glb` | TV.js:117 | GLTF model, Draco-compressed. Meshes: `Glass` (screen), `Cube001` (button) |
| `hle.io/img/logo-white.svg` | index.html:35 | Header center logo |
| `hle.io/_nuxt/assets/fonts/SupplyFree/*.otf` | styles.css:2-20 | 4 font files: PPSupplyMono Regular/Ultralight, PPSupplySans Regular/Ultralight |

No other files exist in hle_mirror/. Everything else was deleted (old HLE site pages, webpack bundles, favicons, video, draco scripts).

---

## Extension Points

- **Add new form fields**: Edit `CRTTerminal.fields` array. Update `CardPoster.drawCard()` to render them.
- **Change CRT colors**: Edit `CRTTerminal.palettes`. Add new schemes, call `setColorScheme('name')`.
- **Add music**: Drop mp3 at `audio/music.mp3`. Sound toggle already wired.
- **CardPoster night mode**: Currently hardcoded green. Could accept color scheme and redraw.
- **New 3D objects**: Get scene via `tv.getScene()`, add meshes. CardPoster demonstrates the pattern.
- **Scroll-triggered events**: Use `tv.on('animationEnd', callback)` or add more thresholds in `animateCameraPosition()`.

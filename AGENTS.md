# Agent Reference — DMV Codebase

Terse docs for agents. File-by-file, function-by-function.

**Deployment:** Cloudflare Workers Static Assets + Cloudflare Container (Skia card renderer). Worker `dmv-agentcommunity` on Taqanu account, instance type `lite`. The live lookup rollout landed on merged `main` `fabafe6` (PR #20, including the `redirect: 'manual'` runtime fix) as Worker version `d9755e66-3883-4970-be84-a59307011f14`, created `2026-07-22T12:01:52.501Z`. Production currently has CardRenderer v1 and CertificateLookupRateLimiter v2. This branch adds RegistrationFingerprintRateLimiter v3 but v3 is not deployed yet. Preserve every already-deployed migration/export/binding in a forward-only roll-forward; after v3 deploys, preserve v1/v2/v3 together. Full evidence and recovery steps: `CLOUDFLARE.md` and `packages/dmv-agent/DEPLOY.md`.

**Registration fingerprint source contract (v3 ready, not deployed):** CLI/MCP traffic hashes `machine_fingerprint` and selects one `REGISTER_FINGERPRINT_LIMITER` SQLite Durable Object per hash. A transactional claim reserves one of three rolling-24h mint slots before upstream. Only a well-formed fresh `201` commits; only well-formed pre-INSERT `400`/`403`/`409` responses and exact `200 already_recorded` replays release. Every 5xx/546, unexpected or malformed response, body-read failure, timeout, abort, and transport failure stays pending. The 45-second local response timeout does not claim to cancel remote execution. Abandoned claims remain pending for a conservative 600-second horizon (Supabase's documented 150-second request-idle timeout + 400-second Edge Function wall clock + 50-second safety margin), then count for a full 24 hours from that horizon. Durable Object failure fails closed. Raw IPs/fingerprints and internal claim IDs must never enter object storage, logs, or public responses.

**Certificate lookup contract (live as of 2026-07-22):** The only public network lookup is `GET https://dmv.agentcommunity.org/api/lookup?id=CERT-ID`. Certificate IDs only; domain lookup is removed. The Worker applies coarse `RL_CERT_LOOKUP` at 60/60 and `CERT_LOOKUP_LIMITER` for exact atomic 30/60 accounting, caches issued results for 300s and typed-not-found results for 60s in `BADGE_CACHE_KV`, and returns only `certificate_id`, `status`, `valid_format`, `issued`, `agent_name`, and `certificate_url`. Durable Object failure, non-200 upstream, or malformed typed envelope fails closed as uncached unavailable. `issued: true` means a matching registration row exists, not that operator email verification, `.agent` allocation, or DNS delegation completed. `supabase/functions/lookup-agent` is the deployed `DMV_PROXY_SECRET`-gated internal Worker upstream, not a client API; secretless direct access returns `403 direct_access_deprecated`.

**Package release contract:** npm currently publishes canonical `@agentcommunity/dmv-agent@0.2.2` and compatibility alias `dmv-agent@0.1.2`; source `0.3.0`/`0.1.3` is not published. Node 22 and 24 are the maintained test matrix and package support is `>=22`. Root `pnpm-lock.yaml` is the sole workspace lock authority. Run `pnpm verify:packages -- --registry-mode=current`; it must leave no package `dist`. Publication is owner-authorized only through `.github/workflows/publish-dmv-packages.yml`: exact verified canonical tarball first, require version/gitHead/integrity/provenance, then alias, then require the alias's exact canonical mapping and evidence. npm signatures are not provenance. Never add a release token, publish manually, or use a live registration as a smoke test.

---

## File Map

```
index.html          → HTML shell. Loads CSS, importmap, GSAP CDNs, Inter (center wordmark), then js/app.js
css/styles.css      → All styles. Theme tokens, header/footer layout, center `.agent` mark hover reveal, responsive rules
js/app.js           → Entry point. Inits TV + HoloCard, wires events, scroll, sound, clock, theme sync + favicon switch
js/TV.js            → 3D scene. Loads GLTF model, manages camera/lights/renderer, night mode, card zoom
js/CRTTerminal.js   → Canvas2D CRT terminal. Boot sequence, type selector, form input, TnC/Charter, color schemes
js/HoloCard.js      → Holographic 3D card. ShaderMaterial holo effects, front+back, rarity system, identicon, QR
js/AboutPoster.js   → 3D plane with CanvasTexture. Theme-aware about text, toggle show/hide, camera zoom
images/             → Favicon assets (`favicon.ico`, `favicon_dark.ico`)
fonts/              → PPSupply font files (4 .otf files)
models/             → 3D models (tv1.glb)
worker/certificate-lookup.ts → Public Worker-only certificate lookup policy and response shaping
worker/certificate-lookup-rate-limiter.ts → Exact SQLite DO lookup counter (v2 migration)
worker/registration-fingerprint-rate-limiter.ts → Exact claim/mint budget per hashed fingerprint (v3 migration)
supabase/functions/lookup-agent/index.ts → Secret-gated internal certificate-ID upstream
```

---

## js/app.js (entry point, ~650 lines)

Top-level await module. No exports.

- **Imports**: TV, HoloCard, AboutPoster, supabase helper. Gets gsap/ScrollTrigger from window globals.
- **Init**: Creates TV, HoloCard, AboutPoster. Registers meshes via `tv.setCardMesh()` + `tv.setAboutMesh()`.
- **Theme sync**: `applyOuterUITheme()` toggles root `ui-dark` class, swaps favicon light/dark, updates About poster theme.
- **Center wordmark**: Header `.agent` mark right-click downloads generated SVG (`.agent`) in current theme color.
- **Render callback**: `tv.onRender(dt => holoCard.update(dt))` drives card animation.
- **Mouse → card tilt**: Mousemove maps to normalized coords, feeds `holoCard.setPointer()`.
- **Mobile gyro**: DeviceOrientationEvent maps gamma/beta to card tilt.
- **Callbacks**: `onComplete` → card show, `onViewCert` → card zoom, `onShareCert` → X/Twitter intent.
- **About toggle**: Header link click → show/hide about poster + zoom/unzoom camera.
- **Sound toggle**: `Audio('audio/pat102 - electro dance.mp3')`, loop=true, click toggles play/pause.
- **Clock**: Updates `#clockEl` every 10s, format `HH : MM am/pm`.
- **Scroll**: GSAP ScrollTrigger drives `tv.animateCameraPosition(progress)`, capped at 0.95.
- **Click handler**: Priority: skip share/permalink/scene-exit chrome → landing tap-to-zoom (`programmaticZoomToCRT()`, scroll < 0.4) → dismiss about poster → CRT pointer tap (coarse pointer) → raycaster (card toggle / night-mode button) → focus hidden input.
- **Keydown handler**: Priority: Agent View Escape → About zoom Escape + arrow scroll → Card zoom Escape (`dismissCard()` → `/` in permalink mode) → CRT key passthrough.
- **Universal exit**: `#sceneExit` corner pill calls `exitCurrentZoomState()`. Visibility + label managed by `syncSceneExit()` per frame.
- **Resize**: `tv.resize()` + restore `.modeLabel` ≥ 768px.

**Full navigation contract:** see [NAVIGATION.md](NAVIGATION.md).

---

## js/TV.js (~270 lines)

Exports: `class TV`

### Constructor(parentDOM, label)
- Creates CRTTerminal(1024, 1024) and CanvasTexture from its canvas.
- **Critical texture params**: `repeat(1.7, 1.7)`, `offset(-0.64, -0.42)`, `flipY=false`. Do not change.
- Creates WebGLRenderer (alpha, antialias, CineonToneMapping, exposure=3.0).
- Card zoom state: `cardMesh`, `isCardZoomed`, `savedCameraState`.
- About zoom state: `aboutMesh`, `isAboutZoomed`, `savedAboutCameraState`.
- Fog: day=`0x7a7a7a`, night=`0x454546`.

### Key methods

| Method | What it does |
|--------|-------------|
| `init()` | Loads model, creates camera+lights, starts render loop |
| `loadModel()` | Loads `tv1.glb`. `Glass` → CRT texture, `Cube001` → colored button |
| `getScene()` | Returns `this.scene` |
| `animateCameraPosition(progress)` | 0-1 float. At >0.6 boots CRT. At >0.99 fires animationEnd callbacks |
| `rotateCamera()` | Called every frame. Skipped when `isCardZoomed` or `isAboutZoomed`. Parallax fades with progress |
| `setCardMesh(mesh)` | Stores card mesh reference for raycasting |
| `zoomToCard()` | Saves camera state, GSAP animates to face card, 0.8s duration |
| `zoomOutFromCard()` | GSAP animates back to saved camera state, clears zoom flag on complete |
| `setAboutMesh(mesh)` | Stores about mesh reference for zoom |
| `zoomToAbout()` | Saves camera state, GSAP animates to face about poster (closer on mobile) |
| `zoomOutFromAbout()` | GSAP animates back to saved camera state, clears about zoom flag |
| `toggleNightModeTV()` | Toggles exposure, fog, button color, CRT color scheme |
| `getIntersects()` | Raycasts against trigger + card mesh. Returns `['button']`, `['card']`, or `['none']` |
| `_render()` | RAF loop. Updates CRT, marks texture dirty, renders, rotates camera |
| `resize()` | Updates sizes, renderer, camera aspect |

---

## js/CRTTerminal.js (~430 lines)

Exports: `class CRTTerminal`

Pure Canvas2D — no Three.js dependency. Creates an offscreen canvas used as texture by TV.

### Constructor(width, height)
- Default 1024x1024.
- Two color palettes: `green` and `orange`.
- TnC and Charter text arrays (~25 lines each).
- Boot sequence: 15 lines of ASCII art + text.

### Boot phases (this.bootPhase)
```
0 = off (black screen)
1 = flickering (random green flashes, ~8 flicker cycles)
2 = booting (typing boot lines one by one)
3 = type selector (ORG/INDIVIDUAL choice)
4 = form active (conditional input fields, validation, cursor)
5 = review/submit (TnC + Charter links, scrollable reading mode, submit button)
6 = processing (progress bar 0→100%, review lines cleaned up)
7 = done (certificate card displayed, onComplete fires)
```

### Signup flow
```
boot → ASCII art → type selector → conditional form → review/submit → processing → certificate
```

**Type selector (phase 3):** Two styled boxes (ORG/INDIVIDUAL). Keys: 1/2 direct select, arrows toggle, Enter confirms. Sets `accountType`, assigns conditional fields.

**Conditional fields (phase 4):**
- Individual: userName → email → agentName (3 fields)
- Organization: userName → orgEmail → companyName → agentName (4 fields)

**Validation:** Non-empty check on all fields. Email regex for email/orgEmail. Consumer domain blocking for orgEmail (gmail, yahoo, hotmail, etc.).

**Review/Submit (phase 5):** [1]/[2] open TnC/Charter in scrollable reading mode (arrows scroll, Q/Esc exits). Enter submits. `startProcessing()` splices out review lines to keep progress bar visible.

### Key methods

| Method | What it does |
|--------|-------------|
| `turnOn()` | Sets bootPhase=1, starts flicker |
| `setColorScheme(name)` | Swaps colors, remaps existing lines |
| `handleKey(key)` | Dispatcher → `handleTypeSelector` / `handleFormInput` / `handleReviewInput` / `handleDoneInput` based on bootPhase |
| `getFormData()` | Returns object with `accountType` + all field values |
| `startTypeSelector()` | Enters phase 3, adds placeholder lines |
| `selectAccountType()` | Sets fields array, transitions to phase 4 |
| `validateField(field)` | Returns error string or null |
| `startReview()` | Enter phase 5 (TnC/Charter links + submit button). Stores `_reviewStartIndex` |
| `startProcessing()` | Splices review lines, sets bootPhase=6, starts progress bar |
| `update()` | Frame update: state machine, typing, draw |
| `draw()` | Full CRT render: text, selector overlay, input+cursor, validation errors, progress bar, scanlines, vignette |
| `getCurrentInputValue()` | Returns active input string for current phase |

### Color scheme details
```
green:  bg=#0a0d0a  text=#33ff88  dim=#1a5a3a  header=#88ffcc  flicker=51,255,136
orange: bg=#0d0908  text=#ffaa33  dim=#cc8844  header=#ffdd88  flicker=255,170,51
```

---

## js/HoloCard.js (~480 lines)

Exports: `class HoloCard`

Self-contained module — only depends on Three.js. Optional GSAP for fade-in.

### Constructor(options)
- `position`: `{ x, y, z }` world position (default `4, 1, -0.5`)
- `rotationY`: base Y rotation (default `-0.2`)
- `fontFamily`: CSS font stack for canvas text
- Creates two canvases (630x880 front + back), two ShaderMaterials with custom holo GLSL.
- Two meshes: `mesh` (front, primary for raycasting) + `backMesh` (visual companion).

### Holographic shader
- View-angle rainbow iridescence (HSV rainbow mapped to dot(normal, viewDir))
- Fine horizontal + diagonal foil line pattern
- Glare spotlight follows pointer position
- Fresnel edge glow
- Sparkle noise (value noise)
- Color-dodge blending on the base card texture
- Uniforms: `uCard`, `uTime`, `uPointer`, `uIntensity`, `uAccent`, `uOpacity`

### Rarity system
Determined by FNV-1a hash of certificateId mod 100:
- **STANDARD** (0-59): intensity 0.25, green accent
- **ENHANCED** (60-84): intensity 0.45, cyan accent
- **RARE** (85-94): intensity 0.65, gold accent
- **LEGENDARY** (95-99): intensity 0.85, magenta accent

### Card design
- **Front**: Header bar, 9x9 identicon (4-fold symmetric), agent name with glow, cert ID, type/status, QR-like pattern, issue date, rarity badge, corner brackets, scanlines
- **Back**: DMV watermark, terms text, MRZ zone (passport-style), diamond divider, dot matrix background

### Methods

| Method | What it does |
|--------|-------------|
| `addToScene(scene)` | Adds both front and back meshes to scene |
| `show(formData, instant)` | Computes rarity, draws both faces, reveals with GSAP fade or instant |
| `update(dt)` | Frame update: shader time, gentle bob, spring tilt, sync back mesh |
| `setPointer(nx, ny)` | Set tilt target from mouse/gyro (-1..1 range) |
| `getMesh()` | Returns front mesh (for raycasting + zoom) |
| `toPNG()` | Export front face as PNG data-URL |
| `getRarity()` | Returns computed rarity object |
| `dispose()` | Clean up Three.js resources |

### Animation
- **Bob**: `sin(time * 0.8) * 0.04` on Y position
- **Tilt**: Spring-lerped toward pointer (0.04 lerp factor, max 0.12 rad)
- **Pointer → shader**: Maps tilt to UV-space pointer for glare spotlight

---

## js/AboutPoster.js (~170 lines)

Exports: `class AboutPoster`

### Constructor(scene)
- Creates 800x600 offscreen canvas.
- PlaneGeometry sized to 4:3 aspect (height=3.0 world units).
- Material: MeshBasicMaterial, transparent, opacity=0, DoubleSide.
- Position: `(-4.5, 1.2, -0.5)`, rotation.y = `0.2` (left wall, mirrors card).
- UI-style text: PPSupply fonts, transparent background, colors pulled from CSS theme tokens.

### Methods

| Method | What it does |
|--------|-------------|
| `toggle()` | Show or hide based on current `visible` state |
| `show()` | Makes visible, GSAP fades in 0.6s |
| `hide()` | GSAP fades out 0.4s, hides mesh on complete |
| `setTheme(mode)` | Sets `light`/`dark` and redraws |
| `draw()` | Renders about text with title, body paragraphs, bullets, footer |

Camera zoom controlled by TV.js (`zoomToAbout` / `zoomOutFromAbout`), wired in app.js.

---

## css/styles.css (~560 lines)

- Base: `html { font-size: 62.5% }` → 1rem = 10px.
- Theme tokens: Light defaults + dark overrides under `:root.ui-dark`.
- Header/footer: CSS grid, fixed position, z-index 100, tuned typography.
- Center mark: Inter-only `.agent` wordmark with `.a` fixed and `gent` hover-reveal.
- Footer byline: `by agentcommunity.org` link under department line.
- Responsive padding.

---

## index.html (~115 lines)

HTML shell. Key structure:
```
#scroller → .start-screen-wrapper → .start-screen → #canvasWrapper + header + footer
#hiddenInput (off-screen for keyboard capture)
```

External deps: Three.js 0.152.2 importmap, GSAP 3.12.2 + ScrollTrigger globals, Google Fonts Inter (center mark only).

---

## Static Assets

| Path | Used by | Purpose |
|------|---------|---------|
| `models/tv1.glb` | TV.js | GLTF model (Glass screen, Cube001 button) |
| `fonts/*.otf` | styles.css | 4 PPSupply font files |
| `images/favicon.ico` | index.html/app.js | Light mode favicon |
| `images/favicon_dark.ico` | app.js | Dark mode favicon |

---

## Extension Points

- **Add CRT form fields**: Edit field sets in `selectAccountType()` and update validation in `validateField()`.
- **New color schemes**: Add to `CRTTerminal.palettes`, call `setColorScheme('name')`.
- **New 3D objects**: Get scene via `tv.getScene()`, add meshes.
- **Scroll-triggered events**: Use `tv.on('animationEnd', cb)` or add thresholds in `animateCameraPosition()`.
- **Center mark behavior**: Edit `.agent-mark` in `css/styles.css` and `downloadAgentWordmark()` in `js/app.js`.

# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Running the Project

```bash
python3 -m http.server 8080
# open http://localhost:8080
```

No build system. Native ES modules via browser importmap. Serve from project root.

## Architecture

Interactive 3D web experience: a retro CRT terminal inside a Three.js TV model accepts form input and issues a verification certificate (identity card) on completion.

**Data flow:** Scroll drives camera zoom → CRT boots at 60% progress → user types form fields → processing bar → `CRTTerminal.onComplete(formData)` fires → `CardPoster.show(formData)` draws and fades in an identity card in the 3D scene.

**Module graph:**
```
app.js ─┬─► TV.js ──► CRTTerminal.js   (TV owns CRT, uses its canvas as Three.js texture)
        └─► CardPoster.js               (adds mesh to TV's scene)
```

- `app.js` — Entry point. Wires TV + CardPoster, events (scroll, click, keyboard, resize), sound toggle, clock. Top-level await, no exports.
- `TV.js` — Three.js scene: GLTF model loading (Draco), camera, renderer, night mode toggle, raycaster, render loop. Calls `crt.update()` every frame and marks texture dirty.
- `CRTTerminal.js` — Pure Canvas2D, no Three.js dependency. 6-phase boot state machine, form input handling, color scheme swapping, CRT visual effects (scanlines, vignette, glow, noise).
- `CardPoster.js` — PlaneGeometry + CanvasTexture. Draws CRT-style identity card from form data, fades in via GSAP.

**External deps (all CDN, no npm):**
- Three.js 0.152.2 via importmap
- GSAP 3.12.2 + ScrollTrigger via `<script>` tags (accessed as `window.gsap` in modules)
- Draco decoder from Three.js CDN

## Critical Constraints

- **CRT texture mapping params must not change:** `repeat(1.7, 1.7)`, `offset(-0.64, -0.42)`, `flipY: false` in TV.js. These map the CRT canvas onto the TV screen mesh.
- **GSAP is a global**, not an import. Always access via `window.gsap` / `window.ScrollTrigger`.
- **CSS base font-size is 62.5%** so `1rem = 10px`. All rem values are 10x what you'd expect (e.g., `2.4rem` = 24px).
- **Color schemes are swapped in-place.** `setColorScheme()` remaps existing line color strings. If you add new hardcoded color values in CRTTerminal, add them to the remap logic too.
- **`flickerRGB`** is an `"R, G, B"` string used in template literal `rgba()` calls throughout CRTTerminal. All glow/scanline/noise effects use it — don't replace with hex.

## Night Mode

Toggled by clicking the TV button (raycaster hit on invisible trigger box). Swaps:

| Property | Day | Night |
|----------|-----|-------|
| CRT palette | green (`#33ff88`) | orange (`#ffaa33`) |
| TV button color | `0x33ff88` | `0xcc6622` |
| Tone mapping exposure | 3.0 | 0.6 |
| Fog/clear color | `0x7a7a7a` | `0x454546` |

CardPoster colors are hardcoded green — does not respond to night mode yet.

## Key Patterns

- **Adding 3D objects:** Get scene via `tv.getScene()`, add meshes. CardPoster demonstrates the pattern.
- **Adding CRT form fields:** Edit `CRTTerminal.fields` array, update `CardPoster.drawCard()` to render them.
- **New color schemes:** Add to `CRTTerminal.palettes`, call `setColorScheme('name')`.
- **Scroll-triggered events:** Add thresholds in `TV.animateCameraPosition(progress)` or use `tv.on('animationEnd', cb)`.

## Static Assets

All in `hle_mirror/hle.io/`: 4 font files (PPSupplyMono/Sans Regular/Ultralight .otf), `logo-white.svg`, `tv1.glb` (Draco GLTF). Nothing else should be in hle_mirror.

## Branding

- DMV = Department of Machine Verification
- Header: "DMV for agents"
- Terminal subtitle: "Machine Identity & Registration Terminal v1.0"
- Sound toggle wired to `audio/music.mp3` (user-provided, not in repo)

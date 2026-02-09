# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Running the Project

```bash
uv run python -m http.server 8080
# open http://localhost:8080
```

No build system. Native ES modules via browser importmap. Serve from project root.

## Architecture

Interactive 3D web experience: a retro CRT terminal inside a Three.js TV model accepts form input and issues a holographic verification certificate (identity card) on completion.

**Data flow:** Scroll drives camera zoom → CRT boots at 60% progress → type selector (org/individual) → conditional form fields with validation → review/submit (TnC + Charter links, submit button) → processing bar → `CRTTerminal.onComplete(formData)` fires → `HoloCard.show(formData)` draws holographic card with rarity-based shader effects → card bobs + tilts toward mouse/gyro → card is clickable to zoom.

**Module graph:**
```
app.js ─┬─► TV.js ──► CRTTerminal.js   (TV owns CRT, uses its canvas as Three.js texture)
        ├─► HoloCard.js                (holographic card, self-contained module)
        └─► AboutPoster.js             (about panel)
```

- `app.js` — Entry point. Wires TV + HoloCard + AboutPoster, events (scroll, click, keyboard, resize, gyro), sound toggle, clock, permalink routing. Top-level await, no exports.
- `TV.js` — Three.js scene: GLTF model loading (Draco), camera, renderer, night mode toggle, raycaster, card/about zoom/unzoom, `onRender(cb)` callbacks, render loop with delta time.
- `CRTTerminal.js` — Pure Canvas2D, no Three.js dependency. 8-phase boot state machine (off, flicker, boot text, type selector, form, review/submit, processing, done), conditional form fields with validation, color scheme swapping, CRT visual effects.
- `HoloCard.js` — Self-contained holographic card module. Custom ShaderMaterial (GLSL) with rainbow iridescence, foil lines, glare, fresnel, sparkle. Front + back faces with Canvas2D content. Rarity system, identicon, QR pattern. Bob + tilt animation. See [CARD.md](CARD.md).
- `CardPoster.js` — **Legacy.** Original flat card, replaced by HoloCard.js.
- `AboutPoster.js` — PlaneGeometry + CanvasTexture. UI-style about text, toggle show/hide.

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
- **Cache busting:** All imports use `?v=N` query params. Bump in app.js imports, TV.js import, AND index.html script tag together.

## Night Mode

Toggled by clicking the TV button (raycaster hit on invisible trigger box). Swaps:

| Property | Day | Night |
|----------|-----|-------|
| CRT palette | green (`#33ff88`) | orange (`#ffaa33`) |
| TV button color | `0x33ff88` | `0xcc6622` |
| Tone mapping exposure | 3.0 | 0.6 |
| Fog/clear color | `0x7a7a7a` | `0x454546` |

HoloCard shader is tone-mapped, so it dims in night mode but holo effects still show through.

## Permalink System

Hash format: `#/CERT-ID` (optionally `#/CERT-ID/agentname`).

In permalink mode:
- Card shown instantly, camera jumps to it
- Header "About" swapped to green "Get Yours" CTA
- Bottom overlay: "Get Yours" + "Share on X" buttons with backdrop blur
- Click anywhere or Escape to zoom out to full scene view
- Footer hidden to avoid overlap with overlay
- Scroll still wired — visitors can explore after unzooming

## Key Patterns

- **Adding 3D objects:** Get scene via `tv.getScene()`, add meshes. HoloCard demonstrates the pattern.
- **Frame-synced updates:** Use `tv.onRender(cb)` to get delta-time callbacks in the render loop.
- **Adding CRT form fields:** Edit the field sets in `CRTTerminal.selectAccountType()`.
- **New color schemes:** Add to `CRTTerminal.palettes`, call `setColorScheme('name')`.
- **Scroll-triggered events:** Add thresholds in `TV.animateCameraPosition(progress)` or use `tv.on('animationEnd', cb)`.
- **Zoom transitions:** When transitioning between zoomed states (card → about), unzoom first with a delay, then zoom to new target.

## Static Assets

All in `hle_mirror/hle.io/`: 4 font files (PPSupplyMono/Sans Regular/Ultralight .otf), `logo-white.svg`, `tv1.glb` (Draco GLTF). Nothing else should be in hle_mirror.

## Backend & NPM Package

See [ARCHITECTURE.md](ARCHITECTURE.md) for the full system map.

**Edge functions** (`supabase/functions/`): registration proxy, lookup API, badge SVG generator. All Deno, deployed to Supabase. Zero secrets in client code — all DB writes go through edge functions.

**NPM package** (`packages/dmv-agent/`): CLI, MCP server, JS API, Claude Code `/dmv` skill. TypeScript, pnpm for dev, bunx for users. Only runtime dep: `@modelcontextprotocol/sdk`.

**Go-live checklist**: `packages/dmv-agent/DEPLOY.md`

## Branding

- DMV = Department of Machine Verification
- Part of the [.agent community](https://agentcommunity.org) — ICANN application for `.agent` gTLD
- Header: "DMV for agents"
- Terminal subtitle: "Machine Identity & Registration Terminal v1.0"
- Sound toggle wired to `audio/music.mp3` (user-provided, not in repo)

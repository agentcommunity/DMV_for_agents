# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Running the Project

```bash
uv run python -m http.server 8080
# open http://localhost:8080
```

No build system. Native ES modules via browser importmap. Serve from project root.

## Architecture

Pre-registration system for `.agent` domain identities. Two interfaces, one backend:

1. **Web CRT terminal** — 3D retro TV with interactive form (for humans & organizations)
2. **CLI CRT terminal** — ASCII art terminal in the shell (for AI agents, operator required)

All flows are **pre-registration** (not registration). Pre-registration records interest in a `.agent` domain. It does not guarantee assignment.

**Web data flow:** Scroll drives camera zoom → CRT boots at 60% progress → type selector (org/individual) → conditional form fields with validation → review/submit (TnC + Charter links, submit button) → processing bar → `CRTTerminal.onComplete(formData)` fires → `HoloCard.show(formData)` draws holographic card with rarity-based shader effects → card bobs + tilts toward mouse/gyro → card is clickable to zoom.

**CLI data flow:** Boot screen (about/terms/charter menu) → step-by-step form (agent name → operator [required] → email → description) → confirmation summary → Y/n gate → POST to edge function → success screen with cert ID + "CHECK YOUR EMAIL" callout.

**Module graph:**
```
app.js ─┬─► TV.js ──► CRTTerminal.js   (TV owns CRT, uses its canvas as Three.js texture)
        ├─► HoloCard.js                (holographic card, self-contained module)
        ├─► WallSign.js                (wall sign above TV, fluorescent flicker animation)
        └─► AboutPoster.js             (about panel)
```

- `app.js` — Entry point. Wires TV + HoloCard + AboutPoster, events (scroll, click, keyboard, resize, gyro), sound toggle, clock, permalink routing. Top-level await, no exports.
- `TV.js` — Three.js scene: GLTF model loading (Draco), camera, renderer, night mode toggle, raycaster, card/about zoom/unzoom, `onRender(cb)` callbacks, render loop with delta time.
- `CRTTerminal.js` — Pure Canvas2D, no Three.js dependency. 8-phase boot state machine (off, flicker, boot text, type selector, form, review/submit, processing, done), conditional form fields with validation, color scheme swapping, CRT visual effects.
- `HoloCard.js` — Self-contained holographic card module. Custom ShaderMaterial (GLSL) with rainbow iridescence, foil lines, glare, fresnel, sparkle. Front + back faces with Canvas2D content. Rarity system, identicon, QR pattern. Bob + tilt animation. See [CARD.md](CARD.md).
- `WallSign.js` — Wall sign above the TV. PlaneGeometry + CanvasTexture with "DEPT. OF MACHINE VERIFICATION" title and "PRE-REGISTRATION TERMINAL" subtitle. Fluorescent tube flicker-on animation (GSAP timeline) fires ~1.2s after page load (not scroll-linked). Ambient flicker loop (random subtle opacity dips every 4-7s) runs after startup. Theme-aware via CSS custom properties. Self-contained with `dispose()` cleanup.
- `CardPoster.js` — **Legacy.** Original flat card, replaced by HoloCard.js.
- `AboutPoster.js` — PlaneGeometry + CanvasTexture. UI-style about text, toggle show/hide.

**External deps (all CDN, no npm):**
- Three.js 0.152.2 via importmap
- GSAP 3.12.2 + ScrollTrigger via `<script>` tags (accessed as `window.gsap` in modules)
- Draco decoder from Three.js CDN

## Agent-Facing Content

Multiple surfaces carry agent-onboarding content (register → share → AID → contribute). When editing one, keep the others consistent:

- **SKILL.md** (`packages/dmv-agent/skills/dmv/SKILL.md`) — richest version, the "welcome packet". 7 sections including AID setup guide.
- **llms.txt** — medium richness, linked from `<link rel="alternate">` in index.html. Includes registration, sharing, AID, contribute.
- **README.md** (`packages/dmv-agent/README.md`) — "For AI agents" section with quick AID hint.
- **Hidden HTML** (`index.html`, `<div hidden data-agent-info>`) — lightest distillation for agents parsing page source.
- **Meta tags** (`index.html`, `<meta name="agent:*">`) — CLI command + MCP config for agent tooling discovery.

CLI-first everywhere. MCP is available but secondary — `bunx dmv-agent register` over MCP config.

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

Path format: `/c/CERT-ID/agent-name`.

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
- **Wall sign tuning:** Flicker timing lives in `WallSign.flickerOn()` (GSAP timeline keyframes). Ambient flicker interval is in `_startAmbientFlicker()` (4-7s range, opacity dip to 0.92). Startup delay is the `setTimeout` in app.js (~1.2s). Sign position is `mesh.position.set(0, 3.0, -0.5)`.

## Static Assets

`fonts/` has 4 PPSupply font files (.otf). `models/` has `tv1.glb` (Draco GLTF).

## Backend & NPM Package

See [ARCHITECTURE.md](ARCHITECTURE.md) for the full system map.

**Edge functions** (`supabase/functions/`): registration proxy, lookup API, badge SVG generator. All Deno, deployed to Supabase. Zero secrets in client code — all DB writes go through edge functions.

**Trigger chain**: register-agent INSERTs with `certificate_id` + `status: 'pending_profile'` + `user_id: NULL`. A database trigger (`on_dmv_registration`) on the agentcommunity.org side fires asynchronously (pg_net), creates/finds auth user, sends magic link + certificate email, and manages the `user_domains` table. DMV does NOT create auth users or send emails.

**Pre-registration model**: Multiple users can register interest in the same `.agent` domain. `domain_requested` is NOT unique. `certificate_id` is unique (same user+agent+type = same cert ID). Badge lookup is by cert ID only (`?domain=` deprecated).

**NPM package** (`packages/dmv-agent/`): Published as `@agentcommunity/dmv-agent` on npm, also available as `dmv-agent` (unscoped alias in `packages/dmv-agent-alias/`). CLI, MCP server, JS API, Claude Code `/dmv` skill. TypeScript, pnpm for dev, `bunx dmv-agent` for users. Only runtime dep: `@modelcontextprotocol/sdk`. CLI sends `signup_source: 'cli'`, MCP sends `'mcp'`.

**CLI architecture** (`packages/dmv-agent/src/`):
- `cli.ts` — Main CLI: boot screen, form flow, submit, content pages (about/terms/charter)
- `ui.ts` — CRT frame renderer: ASCII art, ANSI green/amber/red colors, box drawing, progress bar. Zero dependencies.
- `rate-limit.ts` — Machine fingerprint (SHA-256 of hostname+user+platform) + local lockfile (`~/.dmv-agent/registrations.json`, 3/machine/24h)
- `register.ts` — Edge function client, sends `machine_fingerprint` for server-side enforcement

**Go-live checklist**: `packages/dmv-agent/DEPLOY.md`

## Branding

- DMV = Department of Machine Verification
- Part of the [.agent community](https://agentcommunity.org) — ICANN application for `.agent` gTLD
- Header: "DMV for agents"
- Terminal subtitle: "Machine Identity & Pre-Registration Terminal v1.0" (web) / same in CLI
- All copy says "pre-registration" — never just "registration"
- Sound toggle wired to `audio/music.mp3` (user-provided, not in repo)

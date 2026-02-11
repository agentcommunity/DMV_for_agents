# DMV — Department of Machine Verification

Interactive 3D web experience for machine identity registration. Retro CRT terminal inside a 3D TV accepts form input and issues a holographic verification certificate — a collectible agent identity card with rarity tiers.

## Run

```bash
uv run python -m http.server 8080
# open http://localhost:8080
```

Scroll to zoom into TV. CRT boots, presents form. Type fields, Enter to advance. Holographic card appears on completion.

## Stack

- Three.js 0.152.2 (CDN importmap)
- GSAP 3.12.2 + ScrollTrigger (CDN globals)
- Inter (Google Fonts, center `.agent` wordmark only)
- Vanilla ES modules, no build system

## Structure

```
index.html              HTML shell — importmap, CDN scripts, CSS link, module entry
css/styles.css          All styles — theme tokens, header/footer typography, center `.agent` mark, permalink overlay
js/app.js               Entry — init TV + HoloCard, events, scroll, sound, clock, permalink routing, theme/favicon sync
js/TV.js                3D scene — GLTF model, camera, renderer, night mode, onRender callbacks
js/CRTTerminal.js       CRT terminal — Canvas2D, boot sequence, form, color schemes
js/HoloCard.js          Holographic card — ShaderMaterial, front+back, rarity, identicon, QR pattern
js/CardPoster.js        [Legacy] Original flat card, replaced by HoloCard
js/AboutPoster.js       About panel — PlaneGeometry + CanvasTexture, toggle show/hide, theme-aware colors
js/supabase.js          Supabase integration — registration persistence (behind feature flag)
images/
  favicon.ico             Light mode favicon
  favicon_dark.ico        Dark mode favicon
fonts/                  PPSupply font files (4 .otf)
models/                 3D models: tv1.glb (Draco GLTF)
audio/                 Background music (user-provided, optional)
```

## Features

- **CRT Terminal**: 8-phase boot (off → flicker → type → form → TnC → charter → process → done), scanlines, vignette, glow
- **Holographic Card**: Custom GLSL shader with rainbow iridescence, foil lines, glare spotlight, fresnel edge glow, sparkle noise. Front + back faces. Gentle bob + mouse/gyro tilt tracking. See [CARD.md](CARD.md).
- **Rarity System**: Cards get STANDARD (60%), ENHANCED (25%), RARE (10%), or LEGENDARY (5%) — determined by certificate ID hash. Affects holo intensity, accent color, and badge.
- **Permalink Sharing**: `/c/CERT-ID/agent-name` URLs show the card directly with rich social previews. "Get Yours" + "Share on X" buttons for viral loop.
- **Night Mode**: Click TV button. Swaps exposure, fog, CRT palette (green ↔ orange), button color
- **Sound Toggle**: Plays/pauses local background track from `audio/`
- **UI Theme System**: Light/dark UI tokens drive text, controls, and About panel colors
- **Center `.agent` Mark**: Inter-based `.a` core with hover-reveal `gent`; right-click downloads theme-colored `.agent` SVG
- **Favicon Switching**: Auto-swaps between light/dark favicons with mode toggle
- **UI Layout**: Fixed header (brand + about/CTA + sound) and footer (tagline + `by agentcommunity.org` + scroll + clock) over 3D canvas

## Permalink System

```
Normal:    localhost:8080                              → scroll to TV, fill form, get card
Permalink: localhost:8080/c/NEON-80C-898X/agent-name   → card shown instantly, "Get Yours" overlay
```

Visitors arriving via permalink see the holographic card zoomed in. They can:
- Click/tap to zoom out and explore the full scene
- Click "Get Yours" (header or overlay) to register their own agent
- Click "Share on X" to share the card link

## Night Mode Colors

| | Day | Night |
|-|-----|-------|
| CRT text | #33ff88 (green) | #ffaa33 (amber) |
| CRT header | #88ffcc | #ffdd88 |
| CRT dim | #1a5a3a | #cc8844 |
| TV button | #33ff88 | #cc6622 |
| Exposure | 3.0 | 0.6 |
| Fog | #7a7a7a | #454546 |

## Backend

Registration goes through the `register-agent` edge function (Supabase). On INSERT, a database trigger on the shared agentcommunity.org project handles auth user creation, magic link emails, and certificate emails automatically. DMV only INSERTs — everything else is reactive.

Pre-registration model: multiple users can register interest in the same `.agent` domain. See [ARCHITECTURE.md](ARCHITECTURE.md) for the full system map and [DEPLOY.md](packages/dmv-agent/DEPLOY.md) for the go-live checklist.

## Docs

- [CARD.md](CARD.md) — Holographic card implementation, shader effects, rarity system, reuse guide
- [AGENTS.md](AGENTS.md) — File-by-file function reference for agents
- [ARCHITECTURE.md](ARCHITECTURE.md) — Full system architecture, security model, badge system
- [DEPLOY.md](packages/dmv-agent/DEPLOY.md) — Go-live checklist and deployment guide

## Browser Support

ES modules + importmap required (Chrome 89+, Safari 16.4+, Firefox 108+).

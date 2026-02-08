# DMV — Department of Machine Verification

Interactive 3D web experience for machine identity registration. Retro CRT terminal inside a 3D TV accepts form input and issues a verification certificate.

## Run

```bash
python3 -m http.server 8080
# open http://localhost:8080
```

Scroll to zoom into TV. CRT boots, presents form. Type fields, Enter to advance. Card appears on completion.

## Stack

- Three.js 0.152.2 (CDN importmap)
- GSAP 3.12.2 + ScrollTrigger (CDN globals)
- Vanilla ES modules, no build system

## Structure

```
index.html              HTML shell — importmap, CDN scripts, CSS link, module entry
css/styles.css          All styles — grid layout, toggle, fonts (1rem = 10px base)
js/app.js               Entry — init TV + CardPoster, events, scroll, sound, clock
js/TV.js                3D scene — GLTF model, camera, renderer, night mode
js/CRTTerminal.js       CRT terminal — Canvas2D, boot sequence, form, color schemes
js/CardPoster.js        Identity card — PlaneGeometry + CanvasTexture, GSAP fade-in
hle_mirror/             Static assets only:
  hle.io/models/tv1.glb   3D TV model (Draco GLTF)
  hle.io/img/logo-white.svg
  hle.io/_nuxt/assets/fonts/SupplyFree/  (4 .otf files)
audio/music.mp3         Background music (user-provided, optional)
```

## Features

- **CRT Terminal**: 6-phase boot (off → flicker → type → form → process → done), scanlines, vignette, glow
- **Night Mode**: Click TV button. Swaps exposure, fog, CRT palette (green ↔ orange), button color
- **Identity Card**: PlaneGeometry at (4,1,-0.5), draws CRT-style card from form data, fades in via GSAP
- **Sound Toggle**: Plays/pauses `audio/music.mp3`, toggle thumb slides on click
- **UI**: Fixed header (brand + logo + sound) and footer (tagline + scroll indicator + clock) over 3D canvas

## Night Mode Colors

| | Day | Night |
|-|-----|-------|
| CRT text | #33ff88 (green) | #ffaa33 (amber) |
| CRT header | #88ffcc | #ffdd88 |
| CRT dim | #1a5a3a | #cc8844 |
| TV button | #33ff88 | #cc6622 |
| Exposure | 3.0 | 0.6 |
| Fog | #7a7a7a | #454546 |

## Agent Docs

See [AGENTS.md](AGENTS.md) for file-by-file function reference.

## Browser Support

ES modules + importmap required (Chrome 89+, Safari 16.4+, Firefox 108+).

# Card System — Agent Identity Card

The holographic card is the certificate issued to agents after pre-registration at the DMV (Department of Machine Verification). It uses a deterministic rendering pipeline — same name always produces the same card — with CSS holographic overlays (pokemon-cards-css style) for the interactive holo effect.

**CARD_VERSION: 2** — Landscape 880x630, CSS holo overlays, CardDNA system.

## Architecture

```
card-draw.js (Single Source of Truth)
├── CardDNA — deterministic trait computation from agent name
├── renderCard() — Canvas2D landscape renderer (880x630)
├── serializeCard() / renderFromSerialized() — save/load
└── Shared: PALETTES, BORDERS, PATTERNS, HOLOS, RARITIES

HoloCard.js (Browser — DOM overlay)
├── DOM card: <canvas> + 4 CSS holo overlays (shine, glare, foil, sparkle)
├── Spring physics: tilt, idle sway, ambient response
├── Hidden Three.js mesh for TV.js raycasting & zoom
├── World-to-screen projection for DOM positioning
└── API: show(), update(), setPointer(), onClick(), toPNG()

card-lab-v2.html (Standalone gallery/lab)
├── Same renderCard() from card-draw.js
├── Own inline CSS holo system (.card class)
├── Gallery UI with controls for holo type, palette, etc.
└── Reference implementation for holo effects

container/src/card-renderer.js (Server — Node.js port)
├── @napi-rs/canvas (Skia-based)
├── Identical CardDNA + renderCard() layout
├── Imports generateQRMatrix from container/src/qr-encode.js
├── Runs inside the Cloudflare Container behind /api/card and /api/og
└── Must stay aligned with js/card-draw.js

container/server.mjs (HTTP wrapper)
├── Hono-based server on port 8080
├── /render?format=card → 880x630 PNG direct from renderCard()
├── /render?format=og   → same card composited on 1200x630 (social share)
└── /healthz → warmup probe used by worker /healthz
```

## Quick Usage

```javascript
import { HoloCard } from './js/HoloCard.js';

const card = new HoloCard();
card.addToScene(scene);

card.show({
  agentName: 'myagent',
  certificateId: 'NOVA-A1B-2C3X',
  accountType: 'individual',
});

// In render loop — pass camera + renderer for DOM positioning
card.update(deltaTime, camera, renderer);

// Mouse position for ambient tilt (-1..1 range)
card.setPointer(normalizedX, normalizedY);
```

## Module API

| Method | Returns | Description |
|--------|---------|-------------|
| `new HoloCard(options?)` | instance | Create card. Options: `position`, `rotationY` |
| `addToScene(scene)` | void | Add hidden mesh to Three.js scene |
| `show(formData, instant?)` | void | Render card canvas, create DOM overlay, apply holo type |
| `update(dt, camera, renderer)` | void | Frame update: bob, spring physics, DOM positioning |
| `setPointer(nx, ny)` | void | Ambient tilt from mouse/gyro (-1..1) |
| `getMesh()` | THREE.Mesh | Hidden mesh for raycasting and zoom |
| `setVisible(bool)` | void | Show/hide DOM card overlay |
| `onClick(cb)` | void | Card click handler (DOM events) |
| `toPNG()` | string | Export canvas as PNG data-URL |
| `getCanvas()` | HTMLCanvasElement | Raw canvas for `toBlob()` / download |
| `getRarity()` | object | Rarity tier object |
| `dispose()` | void | Clean up mesh + DOM |

### formData shape

```javascript
{
  agentName: string,       // "myagent" (displayed as "myagent.agent")
  certificateId: string,   // "NOVA-A1B-2C3X"
  accountType?: string,    // "individual" | "organization" | "agent"
}
```

## Card DNA

Every card trait is deterministically derived from the agent name via `fnv1a()` hash + `mixHash()` salts. Same name always produces the same card — no database needed.

```javascript
import { CardDNA } from './js/card-draw.js';
const dna = new CardDNA('nexus-7');
// dna.palette   → 0..7  (Terminal, Cyberpunk, Golden, Ocean, Volcanic, Arctic, Void, Ember)
// dna.border    → 0..3  (Clean, Circuit, Filigree, Glitch)
// dna.pattern   → 0..3  (Grid, Hex, Topo, Crosshatch)
// dna.holo      → 0..3  (Rainbow, Prism, Aurora, Duochrome)
// dna.rarity    → 0..3  (Standard, Enhanced, Rare, Legendary)
```

### Hash Salts (must be identical across all renderers)

| Trait | Salt | Modulus |
|-------|------|---------|
| palette | `0x9e3779b9` | 8 |
| border | `0x517cc1b7` | 4 |
| pattern | `0x6c62272e` | 4 |
| holo | `0x2e1b2138` | 4 |
| rarity | `0x27d4eb2f` | 100 |

## Holo Effect System

The holo effect uses CSS overlays, not GLSL shaders. Four overlay divs sit on top of the card canvas:

| Overlay | Blend Mode | Effect |
|---------|-----------|--------|
| `.card-shine` | `color-dodge` | Rainbow/prismatic gradient that shifts with pointer |
| `.card-glare` | `overlay` | Radial light hotspot following pointer |
| `.card-foil` | `overlay` | Fine diagonal line pattern |
| `.card-sparkle` | `color-dodge` | Radial sparkle at pointer position |

### Holo Types

| Type | CSS Class | Visual |
|------|-----------|--------|
| Rainbow | (default) | Repeating rainbow `linear-gradient` at `--angle` |
| Prism | `.holo-prism` | `conic-gradient` from pointer position |
| Aurora | `.holo-aurora` | Northern-lights style with greens/purples |
| Duochrome | `.holo-duochrome` | Two-color shift using palette primary + accent |

### CSS Custom Properties (driven by spring physics)

| Property | Range | Drives |
|----------|-------|--------|
| `--mx`, `--my` | 0–100% | Pointer position (shine/glare center) |
| `--angle` | degrees | Gradient rotation |
| `--bg-x`, `--bg-y` | % | Background shift |
| `--card-opacity` | 0–1 | Holo overlay intensity |
| `--pointer-from-center` | 0–1 | Distance from center (sparkle/glare intensity) |
| `--holo-intensity` | 0–1 | Set by rarity tier |

## Rarity System

Computed from `mixHash(fnv1a(name), 0x27d4eb2f) % 100`:

| Rarity | Roll | Drop Rate | Intensity | Stars | Visual |
|--------|------|-----------|-----------|-------|--------|
| STANDARD | 0–49 | 50% | 0.35 | 40 | Subtle shimmer |
| ENHANCED | 50–79 | 30% | 0.55 | 70 | Noticeable rainbow |
| RARE | 80–94 | 15% | 0.75 | 100 | Strong prismatic + seal |
| LEGENDARY | 95–99 | 5% | 0.95 | 150 | Maximum sparkle + seal |

Rarity affects: holo intensity, star field density, rarity badge, rarity seal (RARE+).

## Card Layout (Landscape 880x630)

```
┌─────────────────────────────────────────────────────────────────────┐
│  ┌──────────┐  │  [chip] DEPT. OF MACHINE VERIFICATION    [RARE]  │
│  │          │  │  ────────────────────────────────────────────     │
│  │ IDENTICON│  │                                                   │
│  │  190x190 │  │  agentname.agent                                  │
│  │          │  │                                                   │
│  └──────────┘  │  CERTIFICATE ID                                   │
│                │  NOVA-A1B-2C3X                                    │
│                │  |||||||||||||||||||                               │
│                │  ─────────────────────────────────                │
│  ┌──────┐      │  TYPE       STATUS      PROTOCOL                 │
│  │  QR  │      │  INDIV.     ● VERIFIED  AID/1.0                  │
│  │ CODE │      │                                                   │
│  └──────┘      │  ISSUED     EXPIRES     REGISTRY                 │
│  SCAN          │  2026.02    NEVER       .agent        (seal)     │
│─ ────────── ─ ─│─ ──────────────────────────────────── ─ ─ ─ ─ ──│
│  |||||||||||||  │                    dmv.agentcommunity.org        │
└─────────────────────────────────────────────────────────────────────┘
```

## Card Versioning & Serialization

Cards include a version number so they can be reproduced even if the renderer changes.

```javascript
import { serializeCard, renderFromSerialized, CARD_VERSION } from './js/card-draw.js';

// Serialize a card to JSON
const json = serializeCard('nexus-7', { certId: 'MESA-DD6-660J', accountType: 'individual' });
// → { v: 2, name: 'nexus-7', certId: '...', accountType: 'individual',
//    dna: { palette: 0, border: 2, pattern: 1, holo: 3, rarity: 1 },
//    holoType: 'duochrome', rarityName: 'ENHANCED', paletteName: 'Terminal' }

// Render from saved JSON
renderFromSerialized(canvas, json);
```

The `v` field tracks which renderer version produced the card. If `CARD_VERSION` is bumped (layout changes), old serialized cards can still be identified.

## Animation

### Bob
Gentle vertical float on the hidden mesh: `sin(time * 0.8) * 0.04` world units. The DOM card follows via projection.

### Spring Tilt
Spring-interpolated rotation toward pointer (from card-lab-v2):
- **Active** (mouse over card): lerp rate `0.15`, rotX/Y up to ±20°
- **Idle** (mouse away): lerp rate `0.04`, gentle sway `sin/cos` rotation ±1.5°
- Pointer position drives CSS custom properties for synchronized holo movement

### Fade-in
CSS opacity transition from 0 to 1 over 1.2s on the DOM wrapper.

## Rendering Pipeline

| Context | Renderer | Holo |
|---------|----------|------|
| Main site (`?demo`, CRT form) | HoloCard.js → card-draw.js → DOM + CSS overlays | CSS holo (shine/glare/foil/sparkle) |
| Card lab (`card-lab-v2.html`) | Inline JS → card-draw.js → DOM + CSS overlays | CSS holo (own `.card` class) |
| Server (`/api/card`) | container/src/card-renderer.js → @napi-rs/canvas | None (static 880×630 PNG) |
| OG image (`/api/og`) | Same renderer, composited centered on 1200×630 by container/server.mjs | None (same card, bigger canvas) |

## QR Code

The QR code on each card is a real, scannable QR code encoding the card's permalink URL:

```
https://dmv.agentcommunity.org/c/{CERT-ID}/{agent-name}
```

Implementation: `js/qr-encode.js` (browser) / `container/src/qr-encode.js` (server copy — byte-identical). Byte mode, ECL L, versions 1-6 auto-selected by data length. Reed-Solomon error correction over GF(2^8), 8 data masks with penalty scoring. `scripts/build-cf.mjs` hard-fails the build if the two files drift.

- **Browser**: HoloCard.js injects the encoder into card-draw.js via `setQREncoder(generateQRMatrix)` at module load. card-draw.js calls `_qrEncoder(url)` in `drawQR()`.
- **Server**: container/src/card-renderer.js imports `generateQRMatrix` directly from its sibling `qr-encode.js`.
- **Barcodes**: Code 128B encoding cert ID text and domain name (not URLs). Valid and scannable.

## Card Download

Users can save their card as a PNG:
- **Web**: "Save Card" button in the share bar (post-registration, `?demo`) and permalink overlay
- **CLI**: Direct download URL shown in success screen (`/api/card?id=CERT-ID&name=agent-name`)
- **Programmatic**: `HoloCard.getCanvas()` → `canvas.toBlob()`

## Keeping Renderers Aligned

These files must stay in sync:

| File | Format | Must Match |
|------|--------|------------|
| `js/card-draw.js` | ES module (browser) | Source of truth |
| `container/src/card-renderer.js` | ES module (Node.js, Skia) | Same CardDNA, same layout, same CARD_VERSION |
| `js/qr-encode.js` | ES module (browser) | QR encoder — source of truth |
| `container/src/qr-encode.js` | ES module (Node.js) | Byte-identical copy of `js/qr-encode.js` — build hard-fails on drift |

When changing card rendering:
1. Update `js/card-draw.js` first
2. Bump `CARD_VERSION`
3. Port changes to `container/src/card-renderer.js` (same file structure, `@napi-rs/canvas` instead of the DOM canvas)
4. If the QR encoder changed, copy `js/qr-encode.js` → `container/src/qr-encode.js` (`scripts/build-cf.mjs` will refuse to build otherwise)
5. Eyeball `pnpm cf:test:render` output before shipping
6. Update this document

## Permalink Flow

```
User arrives at /c/CERT-ID/agent-name
  → tv.init({ skipModel: true }) — 2.2MB GLB NOT loaded
  → holoCard.show(permalink, true) + tv.jumpToCard() (instant, no animation)
  → #permalinkOverlay (Get Yours / Share / Save) at bottom
  → #sceneExit pill at top-right labeled "HOME"
  → Header "About" link rewritten as green "Get Yours" CTA
  → Footer + "For Agents" link hidden

Exit paths (all go to /):
  → Escape           → dismissCard() → window.location.href = '/'
  → #sceneExit "HOME"→ exitCurrentZoomState() → dismissCard() → '/'
  → "Get Yours" CTA  → reload('/')

Exit paths that unzoom in-place (lazy-load GLB):
  → Click empty world (raycaster card miss) → tv.zoomOutFromCard()
  → Click the DOM card → dismissCard() — which navigates to '/' (intentional)
```

See [NAVIGATION.md](NAVIGATION.md) for the full state machine and rationale.

## Future Enhancements

- AI-generated art in the identicon area
- Animated entrance (card dealt in from off-screen)
- Card flip animation (back face)
- Particle effects for LEGENDARY rarity
- Mobile gyroscope tilt via `setPointer()`

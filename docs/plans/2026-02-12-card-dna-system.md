# Card DNA System — Procedural Unique Cards

## Problem
Every card looks the same. Dark green, same border, same pattern, same holo. Boring. We want cards people would actually order as physical prints.

## Solution: Card DNA
Every card gets a deterministic "genome" from `fnv1a(agentName + ':trait')`. Same name = same card, always. No AI needed — all procedural Canvas2D + CSS/GLSL.

**Full chaos mode**: palette, border, pattern, and holo are all independent traits. Some combos will be unexpected — that's the fun.

## Traits

### 8 Color Palettes
Complete color systems (bg, primary, secondary, dim, accent, glow):
1. **Terminal** — green/dark (the OG: `#33ff88` on `#0a0d0a`)
2. **Cyberpunk** — hot pink + cyan (`#ff2d95` / `#00ffff`)
3. **Golden** — gold/amber (`#ffd700` on dark brown)
4. **Ocean** — blue/teal (`#00bbff` / `#00ffcc`)
5. **Volcanic** — red/orange (`#ff4422` / `#ffaa00`)
6. **Arctic** — ice blue/white (`#aaddff` on dark navy)
7. **Void** — purple/magenta (`#aa44ff` / `#ff44ff`)
8. **Ember** — orange/coral (`#ff8833` / `#ff4466`)

### 4 Border Styles
1. **Clean** — current double-rect + corner brackets. Elegant.
2. **Circuit** — PCB traces branching inward from border with solder dots at junctions.
3. **Filigree** — ornate corner flourishes with inner curves + diamond accents at edge centers.
4. **Glitch** — displaced border segments with RGB-split ghost borders + random glitch bars.

### 4 Background Patterns
1. **Grid** — vertical + horizontal lines (current)
2. **Hex** — honeycomb hexagonal grid
3. **Topo** — topographic contour lines (concentric warped ellipses from seeded centers)
4. **Crosshatch** — diagonal hatching both directions

### 4 Holo Effects (CSS overlay for test page, GLSL for production)
1. **Rainbow** — full spectrum `linear-gradient` sweep, angle follows cursor
2. **Prism** — `conic-gradient` emanating from cursor position
3. **Aurora** — vertical flowing green/cyan/purple gradient
4. **Duochrome** — two-color shift using palette's primary + accent

### 4 Rarity Tiers
Deterministic from hash. Affects holo intensity + glow strength.
- **STANDARD** (50%) — subtle holo, intensity 0.3
- **ENHANCED** (30%) — moderate holo, intensity 0.5
- **RARE** (15%) — strong holo, intensity 0.7
- **LEGENDARY** (5%) — intense holo, intensity 0.9

**Total unique combos: 8 × 4 × 4 × 4 × 4 = 2,048** (before rarity variations = 8,192 visual variants)

## Architecture

### New Files
- `card-lab.html` — standalone test page, no deps except the font
- Eventually: `js/CardDNA.js` + `js/CardRenderer.js` extracted from lab

### Test Page (`card-lab.html`)
Single self-contained HTML file. Everything inline. Serves from project root (uses `fonts/PPSupplyMono-Regular.otf`).

**Layout:**
```
┌─────────────────────────────────────────────┐
│  CARD LAB · Dept of Machine Verification    │
├─────────────────────────────────────────────┤
│                                             │
│     ┌──────────┐    Controls:               │
│     │          │    - Agent name + random    │
│     │  CARD    │    - Palette (color dots)   │
│     │ PREVIEW  │    - Border (text buttons)  │
│     │          │    - Pattern                │
│     │          │    - Holo effect            │
│     └──────────┘    - Rarity                 │
│                     - Randomize All          │
│                     - DNA readout            │
├─────────────────────────────────────────────┤
│  GALLERY — 8 cards with different names     │
│  ┌───┐ ┌───┐ ┌───┐ ┌───┐ ┌───┐ ┌───┐     │
│  └───┘ └───┘ └───┘ └───┘ └───┘ └───┘     │
└─────────────────────────────────────────────┘
```

**Card interaction:**
- Mouse hover → 3D tilt via CSS `perspective` + `transform: rotateX/Y`
- Holo shimmer via layered CSS overlays with `mix-blend-mode: color-dodge`
- Three layers: rainbow/prism/aurora gradient + cursor-following glare spotlight + fine foil lines
- Gallery cards are clickable → loads into main preview
- Card has rounded corners (canvas clip + CSS border-radius)
- Subtle vignette + scanlines on canvas for premium feel
- Ambient glow behind card matching palette color

**Controls:**
- Clicking a trait button overrides that trait
- Changing the name generates new DNA (clears overrides)
- "Randomize All" picks random name → fresh DNA

**Card rendering:**
- Canvas2D, 630×880 (trading card ratio), displayed at 315×440
- Same layout as current HoloCard (header, identicon, agent name, cert ID, type/status, QR, metadata, rarity badge, footer)
- But now: colors from palette, border from border style, background from pattern

### Key Functions
```
CardDNA(name) → { palette, border, pattern, holo, rarity, seeds... }
renderCard(canvas, name, dna) → draws the full card front
setupCardHover(element) → mouse tracking for 3D tilt + holo
```

### Utility Functions (from current HoloCard, reused)
- `fnv1a(str)` — deterministic hash
- `seededRand(seed)` — reproducible random sequence
- `drawIdenticon(ctx, ...)` — mirrored grid identicon
- `drawQR(ctx, ...)` — decorative QR pattern
- `drawCorners(ctx, ...)` — corner bracket decorations

## Implementation Plan

### Phase 1: Test Page (this branch)
Build `card-lab.html` with all 8 palettes, 4 borders, 4 patterns, 4 holo types. Get the design right. Iterate.

### Phase 2: Pick Winners
After testing, decide which combinations work best. Maybe cut weak ones, add new ones.

### Phase 3: Integrate
Extract `CardDNA.js` and `CardRenderer.js` modules. Update `HoloCard.js` to use CardDNA for trait selection + CardRenderer for canvas drawing. Update GLSL shader to support holo variants.

### Phase 4: Backend
Store card DNA traits with registration. Badge SVG could reflect card palette. Permalink cards show their unique design.

## Notes
- All backgrounds are dark — holo effects (color-dodge blend) need dark base to look good
- Card canvas gets `roundRect` clip for physical card feel
- Identicon uses palette primary color
- QR pattern uses palette primary color
- Rarity badge uses palette accent color (avoids color clashes)
- Certificate ID generated deterministically from agent name
- Font: PPSupplyMono (already in project)

# HoloCard — Holographic Agent Identity Card

The holographic card is the certificate issued to agents after registration at the DMV (Department of Machine Verification). It's a Three.js `ShaderMaterial` with custom GLSL that creates real-time holographic effects — rainbow iridescence, foil lines, glare tracking, sparkle, and fresnel edge glow.

## Quick Usage

```javascript
import { HoloCard } from './js/HoloCard.js';

const card = new HoloCard();
card.addToScene(scene);

// Show with data
card.show({
  agentName: 'myagent',
  certificateId: 'NOVA-A1B-2C3X',
  accountType: 'individual',
});

// In render loop — drives bob, tilt, and shader time
card.update(deltaTime);

// Feed mouse position for tilt (-1..1 range)
card.setPointer(normalizedX, normalizedY);
```

## Module API

| Method | Returns | Description |
|--------|---------|-------------|
| `new HoloCard(options?)` | instance | Create card. Options: `position`, `rotationY`, `fontFamily` |
| `addToScene(scene)` | void | Add front + back meshes to a Three.js scene |
| `show(formData, instant?)` | void | Draw card content, compute rarity, reveal (GSAP fade or instant) |
| `update(dt)` | void | Frame update: shader time, bob animation, spring tilt, back mesh sync |
| `setPointer(nx, ny)` | void | Set tilt target from mouse/gyro. Range: -1 (left/down) to 1 (right/up) |
| `getMesh()` | THREE.Mesh | Front mesh — use for raycasting and zoom calculations |
| `toPNG()` | string | Export front face as PNG data-URL |
| `getRarity()` | object | `{ name, pct, intensity, accent, rgb }` |
| `dispose()` | void | Clean up textures, materials, geometries |

### formData shape

```javascript
{
  agentName: string,       // "myagent" (displayed as "myagent.agent")
  certificateId: string,   // "NOVA-A1B-2C3X"
  accountType?: string,    // "individual" | "org"  (default: "individual")
}
```

## Architecture

```
HoloCard
├── frontCanvas (630x880)  →  frontTex (CanvasTexture)  →  frontMat (ShaderMaterial)  →  mesh
├── backCanvas  (630x880)  →  backTex  (CanvasTexture)  →  backMat  (ShaderMaterial)  →  backMesh
└── animation state (time, tilt, bob)
```

Both meshes use the same GLSL shader. The back mesh is synced to the front mesh's position/rotation + PI on Y-axis.

## Holographic Shader

The shader composites multiple effect layers onto the base card texture:

### 1. Rainbow Iridescence
View-angle dependent rainbow. The hue shifts as the card tilts relative to the camera:
```glsl
float phase = vUv.x * 2.5 + vUv.y * 1.8 + viewAngle * 4.0 + time * 0.08;
vec3 rainbow = hsv2rgb(fract(phase), 0.75, 1.0);
```

### 2. Foil Line Pattern
Horizontal + diagonal lines that shift with view angle, simulating embossed holographic foil:
```glsl
float hLines = sin(vUv.y * 180.0 + viewAngle * 35.0);  // horizontal
float dLines = sin((vUv.x + vUv.y) * 100.0 + viewAngle * 25.0);  // diagonal
```

### 3. Glare Spotlight
Radial brightness hotspot that follows the pointer position:
```glsl
float glare = pow(max(1.0 - length(vUv - uPointer), 0.0), 4.0);
```

### 4. Fresnel Edge Glow
Edges glow brighter (like real cards catching light at grazing angles):
```glsl
float fresnel = pow(1.0 - max(dot(normal, viewDir), 0.0), 3.0);
```

### 5. Sparkle Noise
Procedural noise creates glitter-like sparkle points:
```glsl
float sp = noise(uv * 50 + time) * noise(uv * 70 - time);
sp = pow(max(sp, 0.0), 5.0) * 4.0;
```

### 6. Color Dodge Blending
All layers are composited using color-dodge blend (same technique as Pokemon holo cards CSS):
```glsl
vec3 result = base / (1.0 - overlay);
```

### Shader Uniforms

| Uniform | Type | Description |
|---------|------|-------------|
| `uCard` | sampler2D | Card face canvas texture |
| `uTime` | float | Elapsed time (seconds) |
| `uPointer` | vec2 | Pointer position in UV space (0..1) |
| `uIntensity` | float | Holographic effect strength (set by rarity) |
| `uAccent` | vec3 | Rarity accent color (linear RGB) |
| `uOpacity` | float | Fade-in opacity (0..1) |

## Rarity System

Rarity is deterministic — computed from `fnv1a(certificateId) % 100`:

| Rarity | Roll | Intensity | Accent Color | Visual |
|--------|------|-----------|-------------|--------|
| STANDARD | 0-59 (60%) | 0.25 | Green `#33ff88` | Subtle shimmer |
| ENHANCED | 60-84 (25%) | 0.45 | Cyan `#33ddff` | Noticeable rainbow |
| RARE | 85-94 (10%) | 0.65 | Gold `#ffaa33` | Strong prismatic |
| LEGENDARY | 95-99 (5%) | 0.85 | Magenta `#ff44ff` | Maximum sparkle |

Rarity affects: border color, holo intensity, accent glow, rarity badge text, shader sparkle strength.

## Card Design

### Front Face
```
┌─ ─────────────────────────── ─┐
│  DEPT. OF MACHINE VERIFICATION │  header
│─────────────────────────────── │
│                                │
│      ┌──────────────────┐      │
│      │  9x9 IDENTICON   │      │  unique per agent (4-fold symmetric)
│      │  (generated art)  │      │
│      └──────────────────┘      │
│                                │
│  agentname.agent               │  name (with glow)
│  ─────────────────────────     │
│  CERTIFICATE ID                │
│  NOVA-A1B-2C3X                 │  cert ID (with accent glow)
│                                │
│  TYPE         STATUS           │
│  INDIVIDUAL   ● VERIFIED       │
│                                │
│  ┌──────┐    ISSUED 2025.02.08 │
│  │ QR   │    EXPIRES NEVER     │
│  │ CODE │                      │
│  └──────┘    ★ RARE ★          │  rarity badge
│─────────────────────────────── │
│  dmv.agentcommunity.org        │  footer
└─ ─────────────────────────── ─┘
```

- Background: subtle circuit grid pattern
- Corner bracket decorations (HUD-style)
- Double-border (accent + dim)
- CRT scanline overlay

### Back Face
- Large "DMV" watermark
- Terms of verification text
- Machine Readable Zone (passport-style MRZ)
- Diamond divider with accent color
- Dot matrix background pattern

### Identicon
9x9 grid with 4-fold symmetry, generated from `fnv1a(agentName)`. Each agent gets a unique geometric pattern. This area is designed to be replaceable with AI-generated art in the future.

### QR Pattern
21x21 module QR-like pattern (v1 layout) with proper finder patterns in 3 corners and timing patterns. Data area filled deterministically from cert ID hash. Currently decorative — not scannable.

## Animation

### Bob
Gentle vertical float: `sin(time * 0.8) * 0.04` world units.

### Tilt
Spring-interpolated rotation toward pointer:
- Lerp factor: `0.04` (smooth, slightly laggy feel)
- Max rotation: `0.12` radians (~7 degrees)
- Pointer mapped to shader UV for synchronized glare movement

### Fade-in
GSAP-animated opacity from 0 to 1 over 1.2s (if GSAP available, otherwise instant).

## Permalink Flow

```
User arrives at /c/CERT-ID/agent-name
  → Card shown instantly (jumpToCard)
  → Camera zoomed to card face
  → "Get Yours" overlay at bottom
  → Click card or anywhere → smooth zoom out to full scene (z=20)
  → User can scroll down to register their own agent
  → Escape key also unzooms
```

## Reusing in Other Projects

HoloCard is self-contained. To use in another Three.js project:

1. Copy `js/HoloCard.js` into your project
2. Import and instantiate — only needs `three` in your importmap
3. Call `addToScene()`, `show()`, `update()`, `setPointer()` as needed
4. GSAP is optional (used for fade-in only, falls back to instant)
5. Font falls back to `"SF Mono", "Fira Code", "Courier New", monospace` if PPSupplyMono is unavailable

## Future Enhancements

- Scannable QR code (requires QR encoding library)
- AI-generated art in the identicon area (per-agent unique illustration)
- Night mode color scheme response
- Higher-res OG image export (separate render at 1200x1680)
- Animated entrance (card dealt in from off-screen)
- Touch/drag rotation on mobile
- Particle effects for LEGENDARY rarity

# PRD: Landscape Card in Main Flow

## Problem

The main flow (demo mode + CRT terminal completion) shows a **GLSL shader card** (HoloCard.js) that looks nothing like the **card-lab-v2.html** card. The card-lab-v2 card is the polished reference — it has CSS holo overlays (pokemon-cards-css style), spring physics tilt, idle sway, and looks dramatically better. The shader version is inferior and inconsistent with the design intent.

## Goal

Make the main site show the **exact same card** as card-lab-v2.html — same renderer, same CSS holo overlays, same spring physics. One card system everywhere.

## Current State

### card-lab-v2.html (the good one)
- DOM-based: `<canvas>` + 4 CSS overlay divs (`.card-shine`, `.card-glare`, `.card-foil`, `.card-sparkle`)
- CSS `mix-blend-mode: color-dodge` / `overlay` for holo effects
- CSS custom properties (`--mx`, `--my`, `--angle`, `--card-opacity`, etc.) driven by JS
- Spring physics interpolation in `requestAnimationFrame` loop
- Idle sway when not interacting (gentle rotation + bg shift)
- Mouse/touch tilt with smooth lerp
- 4 holo types via CSS classes: `.holo-rainbow` (default), `.holo-prism`, `.holo-aurora`, `.holo-duochrome`
- Rarity controls `--holo-intensity`
- Canvas rendered by `renderCard()` from `js/card-draw.js` (880x630 landscape)
- Per-card ambient glow via `--card-glow` CSS variable

### HoloCard.js (the bad one — to be replaced)
- Three.js `ShaderMaterial` with custom GLSL vertex/fragment shaders
- Holo effect is a GLSL approximation — looks flat and wrong compared to CSS version
- Canvas rendered by same `renderCard()` from card-draw.js (good)
- Has back face drawing (keep this)
- Provides `.getMesh()` for TV.js raycasting and zoom calculations
- Provides `.setPointer()`, `.update()`, `.show()`, `.onClick()`, `.setVisible()` API used by app.js
- The hidden mesh is needed for TV.js camera zoom targets

## Approach

**Rip out the GLSL shader. Make HoloCard a DOM overlay card using the exact CSS/JS from card-lab-v2.**

### What HoloCard.js becomes

A DOM-based card that:
1. Creates a `.card` container with `<canvas>` + 4 holo overlay divs (same HTML structure as card-lab-v2)
2. Positions itself as a fixed/absolute overlay in the viewport (not inside the Three.js canvas)
3. Uses the **exact same CSS** from card-lab-v2 for holo effects (`.card-shine`, `.card-glare`, `.card-foil`, `.card-sparkle`, holo type classes)
4. Uses the **exact same spring physics** from card-lab-v2 (`getSpring()`, `applyTilt()`, `resetCardSpring()`, `animateHolo()`)
5. Renders the canvas via `renderCard()` from card-draw.js (already works)
6. Keeps a **hidden Three.js mesh** (invisible, no shader) purely for TV.js raycasting and zoom position calculations
7. Adds a gentle vertical bob animation (like the old shader version had)

### API (keep compatible with app.js)

```js
holoCard.addToScene(scene)    // Add hidden mesh to Three.js scene
holoCard.show(formData)       // Render card, create/show DOM overlay, fade in
holoCard.update(dt)           // Bob animation + spring physics tick
holoCard.setPointer(nx, ny)   // Drive tilt from mouse/gyro
holoCard.getMesh()            // Hidden mesh for raycaster
holoCard.setVisible(bool)     // Show/hide DOM overlay
holoCard.onClick(cb)          // Click handler
holoCard.toPNG()              // Export canvas
holoCard.getRarity()          // Rarity info
holoCard.dispose()            // Cleanup
```

### CSS

Extract the holo CSS from card-lab-v2.html into either:
- A `<style>` block injected by HoloCard.js (self-contained), OR
- Added to `css/styles.css`

The CSS includes: `.card`, `.card-shine`, `.card-glare`, `.card-foil`, `.card-sparkle`, `.holo-prism .card-shine`, `.holo-aurora .card-shine`, `.holo-duochrome .card-shine`, and the CSS custom properties.

### Positioning

The DOM card needs to appear where the Three.js card mesh would be. Options:
- **Project the mesh position to screen coords** each frame using `mesh.position` + camera + renderer size → set CSS `transform` on the card container
- Or use a fixed position that matches the current card placement (simpler but less flexible)

The first approach is better — it means zoom transitions still work naturally because TV.js moves the camera, and the DOM card follows the projected position.

### card-lab-v2.html

After this change, card-lab-v2.html should import everything from card-draw.js and the shared holo CSS. Its inline code reduces to just the gallery UI, controls, and state management.

## Files to Change

| File | Change |
|------|--------|
| `js/HoloCard.js` | Rewrite: DOM overlay card with CSS holo + hidden Three.js mesh |
| `css/styles.css` | Add card holo CSS (from card-lab-v2.html) |
| `card-lab-v2.html` | Remove inline holo CSS, use shared styles |
| `js/app.js` | May need minor tweaks for DOM card click handling |
| `js/TV.js` | May need helper to project world→screen coords |

## Files NOT to Change

| File | Why |
|------|-----|
| `js/card-draw.js` | Already correct — landscape renderer (880x630), shared by all |
| `js/CRTTerminal.js` | No card logic |
| `js/AboutPoster.js` | Unrelated |

## Out of Scope

- Back face (flip animation) — keep simple for now, can add later
- Mobile gyroscope tilt — existing `setPointer` API supports it, wire later
- Night mode dimming — DOM overlay dims naturally with page

## Key Reference

The **entire working implementation** lives in `card-lab-v2.html` lines 49-241 (CSS) and lines 443-end (JS). The goal is to extract and reuse, not rewrite.

## Testing

1. `http://localhost:8080?demo` — cards should look identical to card-lab-v2 gallery
2. `http://localhost:8080/card-lab-v2.html` — should still work, using shared code
3. Complete CRT form → card appears with correct holo effect
4. Mouse tilt works on card
5. Card click → zoom still works
6. Permalink `/c/CERT-ID/agent` → card shows correctly

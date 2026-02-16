# CRT Mobile UX — Handoff Notes

**Branch:** `claude/card-dna-system-MTj7j`
**Date:** 2026-02-16
**Status:** Reading mode close is broken on mobile. Boot init lines done. Touch scroll done.

---

## What Changed This Session

### 1. Boot Init Lines (DONE)
Inserted 3 lines between the DMV logo/header and the contextual copy in `bootLines` (CRTTerminal.js:142-144):
- "Initializing registration terminal..." (dim)
- "Connection secure." (dim)
- "Ready for input." (text color)

All marked `bootFiller: true` so they disappear when user presses ENTER (filtered in `startTypeSelector()` at line 273).

**After ENTER, CRT shows only:** DMV logo → "DEPARTMENT OF MACHINE VERIFICATION" → "Machine Identity & Registration Terminal v1.0" → separator → type selector.

### 2. Mobile Touch-Drag Scroll for Reading (DONE)
`touchmove` handler in app.js (lines 616-630) now checks reading mode before aboutPoster:
- `tv.crt.bootPhase === 5 && tv.crt.reviewReading` → drag-scroll CRT content
- 2px deadzone to avoid jitter
- Variable renamed from `aboutTouchY` → `touchDragY`
- `touchstart` tracks Y for both reading and about modes

### 3. Reading Close Button (BROKEN — needs redesign)
Multiple approaches tried, none working on mobile:

**Canvas-based close button** — CRT texture UV mapping (`repeat(1.7, 1.7)`, `offset(-0.64, -0.42)`) makes tap detection unreliable in corner/edge areas. The `getCRTSurfacePointAt` clamps UV values to [0,1] after applying the texture matrix, so taps near edges of the TV screen mesh map to wrong canvas coordinates. All working CRT buttons (type selector, NEXT, SUBMIT, TERMS/CHARTER) are in the center/left of the canvas where UV mapping is reliable.

**DOM pill as close button** — The `#scrollBackPill` button switches to "✕ Close" during reading mode. Logic is correct (syncScrollBackPill + click handler). But the user considers this approach wrong — it's outside the CRT and breaks the terminal metaphor.

---

## Current State of the Pill

**Decision: DELETE the pill entirely.** User doesn't want it. It's a floating DOM button at `position: fixed; top: 1.6rem; z-index: 205`. Remove:
- `index.html:113` — the `<button>` element
- `css/styles.css:635-662` — `.scroll-back-pill` styles
- `js/app.js:37` — `scrollBackPill` const
- `js/app.js:123-137` — `syncScrollBackPill()` function
- `js/app.js:314-322` — pill click handler
- `js/app.js:333` — `syncScrollBackPill()` call in render loop

---

## The Real Problem: Mobile Navigation Inside the CRT

The CRT is a 1024×1024 canvas used as a Three.js texture. On mobile, user interaction goes through:
1. Browser `click` event → `getCRTSurfacePointAt()` converts screen coords to canvas coords via UV hit test
2. `handlePointerTap(x, y, altY)` checks canvas-space tap targets
3. Tap targets are registered each frame in `draw()` via `_addTapTarget()`

**Why edges/corners fail:** The texture matrix transforms mesh UVs to canvas coords. With `repeat(1.7)` only ~59% of the mesh height maps to actual canvas content. The rest maps to clamped edge pixels. Taps in those areas produce clamped coordinates that don't match intended targets.

**Where taps work reliably:** Center and left side of the canvas, roughly the area where existing buttons are drawn (`x: padding + 16`, `y: middle third of canvas`).

### Two viable approaches for reading mode close:

**Option A: Back button on the CRT (left-aligned, in the reliable tap zone)**
- Draw a "← BACK" or "✕ CLOSE" button at the same X position as TERMS/CHARTER buttons (`this.padding + 16`)
- Position it in the vertical center or just above the TERMS/CHARTER button area
- Same dimensions as other working buttons (212-340px wide, 44-52px tall)
- Register `review_close` tap target
- This is the same zone where SUBMIT and TERMS/CHARTER buttons work

**Option B: Scroll up to return**
- When user scrolls up past the terms/charter text, they see the review/submit section again
- Close reading mode automatically when `manualScrollY` reaches 0 (scrolled to top)
- No button needed — natural scroll interaction
- Combine with a visual indicator at the top of reading content: "↑ Scroll up to return"

**Option B is simpler** and avoids the button tap detection issue entirely. It also matches how the content was entered (scrolled down to show terms), reversing it (scroll up) to return feels natural.

---

## CRT Phase Map (for reference)

| Phase | Name | Input | Mobile interaction |
|-------|------|-------|-------------------|
| 0 | Off | — | — |
| 1 | Flicker | — | — |
| 2 | Boot text | Enter/tap | Full-screen tap target (works) |
| 3 | Type selector | 1/2/arrows/Enter | Tap on boxes (works) |
| 4 | Form input | Typing + Enter | Hidden `<input>` + NEXT button tap (works) |
| 5 | Review/submit | 1/2/Enter | TERMS/CHARTER/SUBMIT button taps (works) |
| 5+reading | Terms/Charter | Q/Esc/arrows | **BROKEN on mobile** — no close, drag-scroll works |
| 6 | Processing | — | — |
| 7 | Done | 1/2 | View Cert / Share button taps (works) |

---

## Key Files

- `js/CRTTerminal.js` (1310 lines) — All CRT logic. `drawReadingHints()` at line 659 currently only draws desktop keyboard hints + scroll tap zones.
- `js/app.js` — Event wiring. Touch handlers at lines 586-642. Click → CRT tap at lines 644-655.
- `js/TV.js` — `getCRTSurfacePointAt()` at line 541. UV → canvas coord mapping.
- `css/styles.css` — Pill styles at line 635 (to be deleted). `button { all: unset }` at line 103.

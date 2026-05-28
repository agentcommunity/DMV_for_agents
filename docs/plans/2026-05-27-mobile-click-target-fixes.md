# Mobile click-target redesign + UX fixes — 2026-05-27

Session that fixed a batch of mobile/desktop interaction bugs, most of them
fallout from the `a904ff1` nav-refactor commit. Touches `js/app.js`,
`js/TV.js`, `css/styles.css`, `index.html`.

## What the user reported

1. Day/night toggle stopped working; tapping "kinda everywhere" on mobile
   toggled night mode and/or zoomed.
2. The "SCROLL OR TAP SCREEN" hint looked wrong on desktop.
3. Header "ABOUT FOR AGENTS" read as one phrase, not two menu items.
4. On mobile the Sound toggle and the corner exit pill overlapped.
5. On mobile the soft keyboard hid the CRT input, and there was no obvious
   way to dismiss it.
6. (Follow-up) The entire 3D TV body acted as the night-mode switch on
   mobile; user asked that only the monitor glass trigger zoom and only the
   lamp trigger night mode, with everything else inert.

## Root causes

- **Day/night regression (`a904ff1`)**: the new "tap-anywhere-on-landing →
  slow-zoom" block ran in the window click handler *before* the raycaster
  check. The night-mode toggle is a 3D mesh raycast hit, not a DOM button,
  so `e.target.closest('button')` was null and the landing-zoom block ate
  the click before `toggleNightModeTV()` could run.
- **Whole-TV-is-the-switch (mobile)**: `TV.js loadModel()` scaled the
  invisible night-mode trigger box `3×` and recentered it on the TV at
  `(0,0,2)` for `innerWidth < 768`. That hit box covered the entire model.
- **Scroll hint**: the new `.scroll-hint` duplicated the existing
  `.footer__arrow` on desktop. The hint was always meant to be mobile-only.
- **Header**: two `<a>` with only `gap: 1.6rem`, identical styling, and the
  literal text "For Agents" chaining off "About".
- **Sound vs exit pill**: both anchored to the top-right corner; they're
  contextual opposites (landing vs. focused).
- **`gsap.to(scroller, { scrollTop })` never animated**: the page loads
  gsap + ScrollTrigger but **not** ScrollToPlugin, so scrollTop tweens
  silently no-op.

## Fixes

- **`js/app.js`** — click handler reordered so the raycaster owns the 3D
  affordances: `card` → toggle card zoom, `button` (lamp) → night mode,
  `screen` (CRT glass) → slow-zoom into CRT. Dead-canvas taps now do
  nothing (removed the tap-anywhere fallback). `programmaticZoomToCRT()`
  rewritten as a self-contained `requestAnimationFrame` tween (3s,
  power2.inOut) instead of the no-op gsap scrollTop tween. The tween bails
  if the live `scrollTop` diverges from the value it last wrote (i.e. the
  user scrolled), so it never fights manual scroll for the full 3s. Added a
  `visualViewport.resize` listener (140px threshold) that toggles
  `body.kb-open` + sets `--kb-offset`; `syncSceneExit()` shows a `DONE`
  label while kb-open; `exitCurrentZoomState()` blurs `#hiddenInput` first
  when kb-open so DONE dismisses the keyboard rather than unwinding the scene.
- **`js/TV.js`** — removed the mobile `3×`/recenter bloat on the night-mode
  trigger (now a modest `1.4×` at the original lamp position). Added the
  `Glass` mesh (`this.screen`) as a raycaster target returning `'screen'`.
- **`css/styles.css`** — `.scroll-hint` hidden on desktop, shown only on
  mobile. `About · Agents` separator (`.header-brand__sep`) and "For Agents"
  renamed "Agents". `body.mobile-ui-compact .start-header__right` fades the
  Sound toggle when the exit pill claims the corner. `body.kb-open`
  snaps `.start-screen__canvas-wrapper { top }` up by `--kb-offset * -0.48`
  and fades header/footer/center-cta.
- **`index.html`** — header markup; cache-bust bumps (styles v30→v35,
  app.js v36→v43, TV.js v27→v28).

## Chromium quirks discovered (important for future edits)

- `transform` on the sticky `.start-screen` (100dvh + overflow:hidden)
  resolves to identity — silently dropped. Sibling/child absolute elements
  accept transforms fine.
- A `transition` on `.start-screen__canvas-wrapper` causes both `transform`
  and `top` changes to be silently dropped, because its WebGL `<canvas>`
  child repaints every frame and confuses the compositor. **Snapping** the
  value (no transition) works. We rely on the keyboard's own slide-in
  animation to mask the lack of CSS easing.

## Verification

Raycaster verified at mobile 375×812: CRT center/left → `screen`; lamp pull
→ `button` (toggles night mode); TV body top/bottom and empty canvas →
`none`. kb-open simulation: canvas snaps up −154px, header/footer hidden,
DONE pill shown.

Could **not** verify animations in the preview tool: its tab runs
`visibilityState: "hidden"`, which pauses `requestAnimationFrame` (so both
the scroll tween and the Three.js render loop are frozen there). Confirmed
the click reaches `programmaticZoomToCRT`; the tween path is identical to
the working render loop and runs in a visible real browser.

## Not done / open

- Optional CRT flicker-on-load hint to draw the eye to the tappable screen
  (user floated the idea; not implemented).
- Real-device verification of the keyboard lift + DONE-pill flow on
  iOS Safari / Android Chrome.

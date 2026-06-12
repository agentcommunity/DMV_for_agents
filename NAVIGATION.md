# Navigation & Movement System

How the user moves through the DMV scene on desktop and mobile — every state, every input, every exit. If you're editing `js/app.js`, `js/TV.js`, or any zoom/click/Escape behavior, this is the contract.

Cross-refs: [ARCHITECTURE.md](ARCHITECTURE.md) (system map), [CARD.md](CARD.md) (HoloCard internals), [AGENTS.md](AGENTS.md) (file-by-file).

---

## TL;DR

The 3D scene has **one driving axis** — scroll progress — and **four "deep" UI states** that pop up over it: Card zoom, About zoom, Agent View, CRT reading mode. Every deep state has a **single universal exit**: the corner `#sceneExit` pill (X button). Keyboard Escape works for all of them. Clicking the world or specific overlays does state-specific things.

```
                     ┌─────────────────────┐
                     │  Landing (no zoom)  │  scroll progress 0.00–0.30
                     └─────────┬───────────┘
   Scroll OR tap monitor       │
   (3s GSAP scrollTop tween)   ▼
                     ┌─────────────────────┐
                     │  CRT booting        │  progress 0.30–0.75
                     │  (turnOn at 0.60)   │
                     └─────────┬───────────┘
                               │
                               ▼
                     ┌─────────────────────┐
                     │  CRT interactive    │  progress > 0.75
                     │  Form / Review /    │
                     │  Reading / Done     │
                     └────┬────────┬───────┘
                          │        │
            onComplete    │        │ "1"/"2" → terms/charter
            fires         │        │     │
                          ▼        ▼     ▼
              ┌─────────────────┐  ┌──────────────────┐
              │  Card zoom      │  │  Reading mode    │
              │  (HoloCard)     │  │  (CRT-internal)  │
              └─────────────────┘  └──────────────────┘

  Sideways from any state:
  ┌─────────────────┐   ┌──────────────────────┐
  │  About zoom     │   │  Agent View (DOM     │
  │  (AboutPoster)  │   │  takeover)           │
  └─────────────────┘   └──────────────────────┘

  Direct deep-link:  /c/CERT-ID/agent-name  →  jumpToCard (instant, no animation)
```

---

## States

| State | Driver | Flags | Visible chrome |
|---|---|---|---|
| **Landing** | `lastScrollProgress < 0.30` | none | header, footer, center CTA, `#scrollHint`, "DAY/NIGHT" label |
| **CRT booting** | `lastScrollProgress` between 0.30 and 0.75 | `crtBooted=true` at 0.60 | header, footer, CRT visual on TV |
| **CRT interactive** | `isCRTInteractive() === true` | `tv.crt.bootPhase ≥ 2`, `progress > 0.75` | header, footer (compact on mobile), `#sceneExit` ("HOME" on mobile) |
| **Card zoom** | `tv.isCardZoomed` | `holoCard.getMesh().visible` | `#cardShareBar` (non-permalink), `#sceneExit` ("BACK") |
| **About zoom** | `tv.isAboutZoomed` | `aboutPoster.visible` | `#sceneExit` ("CLOSE") |
| **Agent View** | `agentViewOpen` (DOM takeover) | canvas hidden | full-page agent docs, `#sceneExit` ("CLOSE") |
| **CRT reading** | `tv.crt.bootPhase === 5 && tv.crt.reviewReading` | `'tnc' | 'charter'` | `#sceneExit` ("CLOSE"), on-CRT dismiss hint |
| **Permalink** | `parsePermalink() !== null` at module load | `tv.isCardZoomed=true` via `jumpToCard` | `#permalinkOverlay`, `#sceneExit` ("HOME"), Get-Yours header CTA |

State flags live on `tv` (`isCardZoomed`, `isAboutZoomed`), `tv.crt` (`bootPhase`, `reviewReading`), `aboutPoster.visible`, and module-locals (`agentViewOpen`, `permalink`).

---

## Inputs

### Window-level listeners (`js/app.js`)

| Event | Lines | What it does |
|---|---|---|
| `pointermove` | `app.js:1049` | Updates mouse NDC, syncs About-poster link hover |
| `pointerdown` | `app.js:1054` | Same as pointermove |
| `wheel` (passive:false) | `app.js:1084` | Ctrl+wheel/trackpad pinch → scroll. In CRT reading: drives `handleReviewInput`. In About: scrolls poster |
| `touchstart` | `app.js:1065` | Primes gyro, captures `touchDragY` for reading/About scroll, captures `pinchStartDist` for 2-finger |
| `touchmove` | `app.js:1106` | 2-finger pinch → scroll. Drag in reading → CRT scroll. Drag in About → poster scroll |
| `touchend` | `app.js:1147` | Clears drag/pinch state |
| `gesturestart`/`change`/`end` | `app.js:1162` | Suppresses iOS native pinch zoom — **only when the canvas owns the gesture** (see `shouldSuppressNativeGesture`) |
| `click` | `app.js:1166` | Multi-priority dispatcher (see below) |
| `keydown` | `app.js:1253` | Escape & arrow-key dispatcher (see below) |
| `resize` | `app.js:1321` | Resizes TV, syncs mobile UI, restores `.modeLabel` ≥ 768px |
| GSAP `ScrollTrigger` | `app.js:1026` | Drives `tv.animateCameraPosition(progress)`; toggles `body.scrolled`, sets `--scroll-progress` CSS var |

### Click handler priority (`app.js:1166`)

1. Skip if target is inside `.card-share-bar`, `.permalink-overlay`, or `.scene-exit` (those have their own handlers).
2. **Landing tap-to-zoom** (`app.js:1172`) — if `lastScrollProgress < 0.4` and not in any zoom/permalink state, call `programmaticZoomToCRT()` and return. Header / footer / center-CTA / `<button>` / `<a>` are excluded via `closest()`.
3. If `tv.isAboutZoomed` — UV-hit the about poster, follow link if hit, else swallow.
4. If `tv.crt.inputActive && isCoarsePointer()` — tap CRT surface, dispatch to `crt.handlePointerTap`.
5. Raycaster: `'card'` → toggle card zoom (uses `dismissCard()` when zoomed). `'button'` → toggle night mode (only when CRT is not interactive).
6. Fallback: focus hidden input for CRT typing.

### Keydown handler priority (`app.js:1253`)

1. `agentViewOpen` — Escape closes Agent View. All other keys swallowed.
2. `tv.isAboutZoomed` — Escape closes About. Arrow/PgUp/PgDn/Home/End scroll the poster.
3. `tv.isCardZoomed` — Escape calls `dismissCard()` (which navigates to `/` in permalink mode).
4. Escape (any other state) — CRT reading mode exits to review (`handleReviewInput('Escape')`); otherwise, if CRT-interactive, the scene zooms out via `scrollToTop()`.
5. CRT passthrough — Backspace/Enter/Arrows and printable keys go to `tv.crt.handleKey`.

In the CRT form (boot phase 4), **ArrowUp steps back to the previous field**: the current input is discarded, the previous answer is cleared, and its prompt re-opens for retyping (`CRTTerminal.handleFormInput`).

### Hidden input (`#hiddenInput`)

Mobile keyboard funnel. `inputmode="text"`, `enterkeyhint="next"`. Listens to `input` and `keydown` to mirror typing into the CRT form (`app.js:1228`). Its keydown handler calls `stopPropagation()` while focused (the normal desktop typing state), so it handles Escape (blur + `scrollToTop()`) and ArrowUp (field step-back + re-sync) itself, mirroring the window handler.

---

## Universal exit affordance — `#sceneExit`

The corner pill at top-right. **Single source of truth for "get me out of here."** Replaces the old bottom `#terminalStatusBar` (deleted 2026-05).

**Visibility logic** — `syncSceneExit()` in `app.js:318`, called every frame:

```
visible = agentViewOpen
       || tv.isCardZoomed
       || tv.isAboutZoomed
       || (tv.crt.bootPhase === 5 && tv.crt.reviewReading)
       || (isMobileViewport() && isCRTInteractive() && !isSceneZoom)
```

**Label logic** — same function:

| Context | Label |
|---|---|
| Permalink + card zoomed | `HOME` |
| Mobile, CRT-interactive, no zoom | `HOME` (scrolls back to top) |
| Anything else (About / Agent View / Card / Reading) | `CLOSE` |

**Click action** — `exitCurrentZoomState()` in `app.js:307`, checked in priority order:

1. `agentViewOpen` → `closeAgentView()`
2. `tv.isAboutZoomed` → `closeAbout()`
3. `tv.isCardZoomed` → `dismissCard()` (→ `/` in permalink mode)
4. CRT reading mode → `tv.crt.handleReviewInput('Escape')`
5. CRT-interactive (any viewport) → `scrollToTop()` — keyboard Escape reaches this branch too

**Theming** — `.scene-exit` in `css/styles.css`. Day = green (`#33ff88`), night = orange (`#ffaa33`), driven by `:root.ui-dark`. Position is `top + right` with safe-area insets. z-index 220, above the card share bar (210) and permalink overlay (200).

---

## Entry affordances

### Scroll (works everywhere)

The 300vh `.start-screen-wrapper` with sticky `.start-screen` means scrolling drives the GSAP `ScrollTrigger`, which drives `tv.animateCameraPosition(progress)`. Thresholds:

- `progress > 0.30` — `body.scrolled` class added (fades scroll hint, dims center CTA)
- `progress > 0.60` — `tv.crt.turnOn()` boots the CRT (`TV.js:280`)
- `progress > 0.72` — mobile UI compacts (`syncMobileUICompact`)
- `progress > 0.75` — `isCRTInteractive() === true`
- `progress > 0.99` — `animationEnd` callbacks fire

### Tap-the-monitor (`app.js:1172`)

On landing (`lastScrollProgress < 0.4`), any tap on the canvas runs a **3.0s GSAP `scrollTop` tween** to `scrollHeight * 0.85`. The tween fires ScrollTrigger naturally, so the CRT boots at 0.60 mid-animation and the user watches it come alive — that's the design intent.

```js
function programmaticZoomToCRT() {
  const scroller = document.getElementById('scroller');
  if (!scroller) return;
  const target = scroller.scrollHeight * 0.85;
  if (scroller.scrollTop >= target * 0.95) return;
  gsap.killTweensOf(scroller, 'scrollTop');
  gsap.to(scroller, { scrollTop: target, duration: 3.0, ease: 'power2.inOut' });
}
```

**Why it's not gated to mobile**: desktop users with trackpads or no scroll-wheel benefit too. The hint text says "SCROLL OR TAP SCREEN."

### `#scrollHint`

Bottom-center pill ("SCROLL OR TAP SCREEN ↓"). Fixed position, bobs via CSS `@keyframes scrollHintBob`. Auto-fades via `body.scrolled .scroll-hint { opacity: 0 }` and `body.scene-focused .scroll-hint { opacity: 0 }`. No JS visibility code — pure CSS.

### Permalink (`/c/CERT-ID/agent-name`)

Parsed at module load (`parsePermalink()` in `app.js:12`). When present:

- `tv.init({ skipModel: true })` — TV model is **not** loaded (saves 2.2MB GLB)
- `holoCard.show(permalink, true)` shows the card
- `tv.jumpToCard()` snaps camera to card pose without animation
- `tv.zoomOutFromCard` is monkey-patched to lazy-load the model on first unzoom (`app.js:806`)
- `#permalinkOverlay` shown with Get Yours / Share / Save buttons
- Header "About" link is rewritten to a green "Get Yours" CTA that `reload()`s `/`
- "For Agents" link is hidden
- Footer is hidden via inline style

---

## Exit paths per state

| From | Routes |
|---|---|
| **Card zoom** | `#sceneExit` ("BACK" or "HOME"), Escape, click empty world (raycaster), click DOM card |
| **About zoom** | `#sceneExit` ("CLOSE"), Escape, re-click header "About" link. *Note: clicking empty world is intentionally swallowed* |
| **Agent View** | `#sceneExit` ("CLOSE"), Escape, re-click header "For Agents" link |
| **CRT reading** | `#sceneExit` ("CLOSE"), Escape, `Q` key, click outside `review_scroll_up` tap target (mobile), pull-up overscroll gesture (mobile, 12 ticks) |
| **Permalink (card zoomed)** | `#sceneExit` ("HOME"), Escape, Get-Yours CTA, click empty world (loads TV model on demand) |
| **Mobile CRT-interactive** | `#sceneExit` ("HOME") → scrollToTop, Escape |
| **Landing** | n/a (no zoom state) |

---

## Mobile considerations

- **`100dvh` on `.start-screen`** (with `100vh` fallback) prevents iOS Safari address-bar height jumps.
- **`safe-area-inset-*`** respected on footer, terminal status zone, `#sceneExit`, and `#scrollHint`.
- **2-finger pinch is repurposed as scroll** in non-zoomed contexts (`app.js:1108`) — multiplied by `PINCH_SCROLL_SPEED = 3`. Outside non-zoomed contexts, the gesture is left alone so iOS accessibility zoom still works.
- **`gesturestart` preventDefault is conditional** (`shouldSuppressNativeGesture` in `app.js:1155`). Only fires when canvas owns the pinch (any zoom state, About-poster scroll, reading mode, CRT-interactive). Landing page leaves it alone.
- **Touch-drag in reading mode** scrolls CRT content (`app.js:1128`), 2px deadzone.
- **Touch-drag in About** scrolls the poster (`app.js:1139`), `delta * 1.2` speed.
- **Gyro tilt** for the holo card — `DeviceOrientationEvent`, permission requested silently on first `touchstart` or `click` (`maybeEnableGyro` in `app.js:377`). iOS 13+ requires user gesture; first interaction provides it.
- **CRT pointer taps** — `crt.handlePointerTap` works only in the center/left "reliable tap zone" because the TV mesh's UV mapping is non-trivial (texture `repeat(1.7, 1.7)` with offset). All on-CRT buttons live in this zone. See `docs/CRT-MOBILE-UX-HANDOFF.md` for the historical why.
- **CRT reading dismiss hint** is now shown from the moment reading mode opens (`CRTTerminal.js:803`), with a gesture-progress alpha. Previously it only appeared once already scrolled to the top, which made the pull-up gesture undiscoverable.
- **`.modeLabel` ("Switch Day/Night" hint)** is hidden on first scroll below 768px (`app.js:1032`) and re-shown on resize back to desktop (`app.js:1325`).

---

## Helper functions reference

All in `js/app.js` unless noted.

| Function | Lines | Purpose |
|---|---|---|
| `parsePermalink()` | 12 | Parses `/c/CERT-ID/name` URL on load |
| `setShareHash(certId, name)` | 21 | `history.replaceState` to permalink URL after registration |
| `isCRTInteractive()` | 279 | `progress > 0.75 && bootPhase ≥ 2` |
| `scrollToTop()` | 282 | Smooth scroll the `#scroller` to 0 |
| `programmaticZoomToCRT()` | 288 | 3s GSAP `scrollTop` tween → `scrollHeight * 0.85` |
| `dismissCard()` | 297 | The **only** way to leave card zoom. Permalink-aware (navigates to `/`) |
| `exitCurrentZoomState()` | 307 | Universal exit dispatcher used by `#sceneExit` |
| `syncSceneExit()` | 318 | Per-frame visibility + label update for `#sceneExit` |
| `syncMobileUICompact()` | 333 | Toggles `body.mobile-ui-compact` and `body.scene-focused` |
| `syncCardShareBar()` | 554 | Per-frame visibility for `#cardShareBar` (NDC raycast samples) |
| `openAbout()` / `closeAbout()` | 690 / 708 | About poster zoom in/out (with 860ms card→about handoff) |
| `openAgentView()` / `closeAgentView()` | 742 / 785 | Full-page DOM takeover |
| `shouldSuppressNativeGesture()` | 1155 | Returns true only when canvas owns the pinch |
| `maybeEnableGyro()` | 377 | One-shot gyro permission request |

---

## Design decisions & rationale

### Why a single corner X instead of in-context buttons?

The old `#terminalStatusBar` was a bottom bar visible only during CRT-interactive (no zoom). It scrolled to top or exited reading mode. But during Card / About zoom it was **hidden** because `isSceneFocused === true`, leaving mobile users with no exit other than guessing at the canvas. A persistent corner X solves this with one element. It also avoids competing with the bottom `#cardShareBar` and `#permalinkOverlay` for screen real estate.

### Why tap-the-monitor for zoom-in, not just scroll?

Mobile users on a short page with limited scroll inertia find the 300vh wrapper deep. A tap is more discoverable. The 3s slow tween was chosen by design — fast enough not to feel sluggish, slow enough that the CRT `turnOn()` (which fires at progress 0.60, ~60% through the tween) plays out cinematically. The hint text invites both methods.

### Why does Escape in permalink mode navigate to `/`?

Before: Escape unzoomed to a blank scene (because the GLB wasn't loaded), and the bottom permalink overlay's share/save buttons kept pointing at an offscreen card — visible UI affordances that were no longer addressable. Going home keeps the model lazy-load only for users who explicitly click "Get Yours" or click the empty world.

### Why is the card-unzoom path now a single `dismissCard()`?

Three call sites previously did slightly different things:

- `holoCard.onClick` set DOM card hidden + called `tv.zoomOutFromCard()`
- World-raycaster click on `'card'` called only `tv.zoomOutFromCard()` (DOM card stayed visible mid-animation)
- Escape key set DOM card hidden + called `tv.zoomOutFromCard()`

Consolidating means **one place** to add permalink awareness, share-bar hiding, telemetry, anything else.

### Why is the CRT reading dismiss hint shown from the start?

The pull-up-12-ticks overscroll gesture is genuinely useful but completely undiscoverable. Previously the hint waited until you were already scrolled to the top, by which point most users had given up. Showing it from the start at 0.55 alpha (vs the gesture-progress 0.35–1.0 alpha) keeps it unobtrusive while announcing the option.

### Why `100dvh` with `100vh` fallback?

iOS Safari's address bar collapses on scroll, recalculating `100vh` to a taller value. This caused the sticky `.start-screen` to jump. `100dvh` (dynamic viewport height) sizes to the visible area at all times. The `100vh` fallback covers Firefox versions that don't yet support `dvh`.

---

## Z-index inventory

For predictable stacking when adding new overlays:

| Element | z-index | File |
|---|---|---|
| `.start-header` | 100 | `styles.css:197` |
| `.center-cta` | 100 | `styles.css:284` |
| `.start-screen__footer` | 100 | `styles.css:352` |
| `.scroll-hint` | 99 | `styles.css` (new) |
| `.permalink-overlay` | 200 | `styles.css:440` |
| `.card-share-bar` | 210 | `styles.css:506` |
| `.scene-exit` | 220 | `styles.css` (new) |
| `.agent-view` | 50 | `styles.css:943` |
| TV button trigger box | n/a (3D) | `TV.js:200` |

---

## When you change this system

1. Read the **State** and **Inputs** tables above to confirm you understand the surface you're touching.
2. If you add a new "deep" UI state, add it to `syncSceneExit()` visibility logic and `exitCurrentZoomState()` dispatch — otherwise the X button won't know about it.
3. If you add a new input that takes the user **out** of a state, prefer routing through `exitCurrentZoomState()` rather than calling `closeX()` directly. Single source of truth.
4. If you add a new permalink-aware behavior, check both the explicit `if (permalink)` guard pattern and the implicit "is the TV model loaded yet" question (see the `loadModelDeferred()` monkey-patch in `app.js:776`).
5. Update this document.

---

## Related docs

- [ARCHITECTURE.md](ARCHITECTURE.md) — system map, backend, NPM package
- [CARD.md](CARD.md) — holographic card internals, permalink card rendering
- [CLOUDFLARE.md](CLOUDFLARE.md) — Worker / Container / cache hierarchy
- [AGENTS.md](AGENTS.md) — terse per-file reference
- [docs/CRT-MOBILE-UX-HANDOFF.md](docs/CRT-MOBILE-UX-HANDOFF.md) — historical context on why CRT taps fail at the edges

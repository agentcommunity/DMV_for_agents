# INTRO.md — the cinematic "video mode" intro

The landing page opens with a one-shot cinematic intro: **black → click to enter → a warm volumetric "lamp" rises behind the monitor like a sunrise → god-ray beams sweep over the top → front-lit reveal of the normal scene, with the music's bass drop landing exactly on the reveal.** Then it hands off to the normal landing (scroll to zoom into the CRT).

Code: [`js/Intro.js`](js/Intro.js) (choreography), [`js/volumetric-pass.js`](js/volumetric-pass.js) (the lamp + god-rays), [`js/app.js`](js/app.js) (the gate + audio), `#introOverlay` / `#introEnter` in [`index.html`](index.html), `.intro-overlay` / `.intro-enter` in [`css/styles.css`](css/styles.css). Tunable live via `?tune` (see [Tuning](#tuning)).

---

## 1. Click-to-enter gate (why the intro waits for a tap)

The scene loads fully and then **holds on its dark, static first frame** — shutter closed (`_barAmt = 1`), exposure `0.42`, lamp seated at the arc start (`a = 0`) — behind a full-screen **`#introEnter` "click to enter"** button. Nothing animates and no audio plays until the user taps.

**Why a gate instead of autoplay:** no browser allows audio to autoplay *with sound* on a cold page load — Safari/iOS hard-block it, with no override. Earlier attempts (muted autoplay, then unmute on the first gesture) **desynced** the music: unmuting mid-track on Safari shifts where the audio actually becomes audible. The gate removes the whole problem — one real user gesture starts **both** the audio and the timeline, so they begin together and stay locked in sync **in every browser**.

On tap (`enterExperience()` in `app.js`):
1. **`primeAudio()`** — a silent `play()` + `pause()` + reset on the `<audio>` element *inside the gesture*. This "blesses" the element so the browser allows the real, in-sync `play()` later at the music beat (the standard audio-unlock technique).
2. **`intro.play()`** — starts the GSAP timeline.
3. The gate fades out; Space/Enter/Esc now **skip** the intro (before entering, Enter/Space *enter*).

Entry is universal (every browser shows the gate). Entry inputs: **tap/click, Enter, or Space**.

---

## 2. Music — where it starts, why, and where it "stops"

The track is [`audio/pat102 - electro dance.mp3`](audio/) (155.12 s, 130 BPM), set to **`audio.loop = true`**.

### Where it starts
The music does **not** start at the tap and does **not** start at the sunrise. It is **synced to the reveal**: it starts so that the track's loud **drop lands exactly when the default white light floods in**. The drop was measured at **`dropAt = 14.85 s`** into the track (130 BPM, 32-beat / 8-bar intro; EBU R128 +9 dB and sub-150 Hz bass +14 dB step up; BPM cross-check 14.77 s).

In [`Intro.js` `_buildTimeline()`](js/Intro.js):
```js
const REVEAL_LIGHT = BLACK + 0.05;                       // the instant the black starts lifting
const musicAt = Math.max(0, REVEAL_LIGHT - dropAt + dropVsReveal);
tl.call(() => this.onStart(), null, musicAt);            // onStart = startIntroAudio
```
So `musicAt = REVEAL_LIGHT − dropAt + dropVsReveal`. The drop (at `musicAt + dropAt`) therefore lands on `REVEAL_LIGHT`, plus the `dropVsReveal` nudge.

**Why derive from the reveal, not the sunrise:** the music start auto-tracks the visuals. Retune any lamp leg and the drop *stays* glued to the reveal — no re-deriving an offset. With the baked timing the music starts at **≈2.62 s**, just **0.25 s after the sunrise**, so the track's light intro carries the whole colour phase and the bass cracks as the scene lights up.

`config.music = { dropAt: 14.85, dropVsReveal: 0 }`. The `?tune` slider **"drop vs reveal (s)"** edits `dropVsReveal` (`0` = drop on the reveal, `+` later, `−` earlier).

### Where it "stops"
It doesn't. `audio.loop = true`, so the track loops continuously (≈2:35) as the page's background music. The intro timeline finishing does **not** stop it. The only thing that pauses/resumes the music is the header **Sound toggle** (`#soundToggle`). (`primeAudio` does a momentary play+pause to unlock — that's not the real start; the real, audible start is `startIntroAudio` at `musicAt`, which seeks to 0 and fades up.)

---

## 3. Lighting — the volumetric lamp arc

The "lamp" is **not** a faked sprite/glow. It is a real **shadow-casting `DirectionalLight` + a full-screen volumetric ray-march** (god-rays) composited over the scene render target — see [`js/volumetric-pass.js`](js/volumetric-pass.js) and [CLAUDE.md](CLAUDE.md). A single normalized arc value **`a ∈ [0,1]`** (`Intro._S.a`, GSAP-tweened) drives everything each frame via `pass.driveArc(a, params)`.

### What `a` controls (`driveArc`)
- **Position** — the lamp swings on an arc, always aimed at the monitor (`SUBJECT`):
  `th = 202° → 38°` as `a: 0 → 1`; `pos = SUBJECT + (1.0, sin(th)·6.5, cos(th)·9)`.
  - `a = 0` → **behind + low** → backlit **silhouette**.
  - `a ≈ 0.5` → **over the top** → god-ray **beams**.
  - `a = 1` → **high + front** → **front-lit reveal**.
- **Brightness** — 3-point piecewise-linear envelope `0.52 → 1.56 → 2.60` (at `a = 0 / 0.5 / 1`).
- **Volumetric density** — `up = smoothstep(0.05,0.30,a)`, `front = smoothstep(0.55,0.95,a)`; `density = base · up · (1 − 0.7·front)`. So the haze **glows up** for the silhouette, **peaks mid-arc** (the beams), and **thins out** for a clean reveal.

### How time maps onto `a` — the four legs
The timeline tweens `a` across three legs (config `timing`, baked values shown), with `aBehind = 0.30`, `aTop = 0.65`:

| Leg | `a` range | Baked length / curve | What you see |
|-----|-----------|----------------------|--------------|
| ② **Sunrise** | `0 → 0.30` | 5.7 s, smooth | exposure `0.42 → 3.0`; lamp glows up **behind** → the silhouette emerges |
| ③ **Rise** | `0.30 → 0.65` | 4.8 s, constant | lamp travels **behind → over the top** → god-ray beams sweep |
| ④ **Crest** | `0.65 → 1.0` | 3.5 s, decelerate | lamp goes **over the top → high front** → the silhouette is front-lit |

(① **Lead-in** is the dark beat between the CRT button catching and first light: `leadIn = 0.95 s`.)

### The handoff to the normal scene (the "reveal")
After the crest, the warm volumetric "colour phase" hands off to the normal flat-lit "default phase" **under cover of black** so there's no jump:

1. brief hold (0.20 s) at full arc,
2. **fade to black** (DOM black layer, `fadeLength = 0.85 s`),
3. at full black, `_restoreScene()` swaps the volumetric pass out and restores the exact normal lighting,
4. **reveal** — lift the black (`revealLength = 0.90 s`) → the normal scene appears. **`REVEAL_LIGHT` = the instant this lift begins**, and **the music's drop is synced to it**,
5. the wall sign stutters in (`signRevealDelay` later), then the letterbox bars open.

So: *colour phase* (sunrise→rise→crest, light music) → fade to black → **drop + the default light floods in** → normal landing.

---

## 4. Full timeline (baked config)

Beats are **derived** from `firstLight` + the leg lengths, so changing any leg stretches the whole sequence. `firstLight = POWER(0.30) + catchAt(1.12) + leadIn(0.95) = 2.37`.

| Beat | Time (s) | Meaning |
|------|----------|---------|
| shutter cracks to letterbox | 0.1 | frame opens so the button flicker is visible |
| `POWER` button flicker | 0.30 | CRT power button stutters on |
| `firstLight` — Sunrise begins | 2.37 | exposure rises, lamp glows up behind |
| **music starts** (`musicAt`) | **2.62** | audible track start (≈0.25 s after the sunrise) |
| Rise begins | 8.07 | lamp behind → over the top |
| Crest begins | 12.87 | lamp over the top → front |
| `ARC_END` | 16.37 | crest done; full front-lit |
| `FADE_START` | 16.57 | begin fade to black |
| `BLACK` | 17.42 | full black; normal scene restored under cover |
| **`REVEAL_LIGHT`** — reveal begins | **17.47** | black lifts → default light floods in · **music drop lands here** |
| `REVEAL_DONE` | 18.37 | normal scene fully shown |
| `SIGN_REVEAL` | 19.37 | wall sign stutters in |
| `END` | ≈22.05 | letterbox open; `onComplete` → `_finalize()` |

---

## 5. Tuning

Open `?tune` for the live control panel ([`js/intro-control-panel.js`](js/intro-control-panel.js), gated + fully removable via `grep -rn DEV-TUNE js/`). Key knobs:
- **Lamp timing** — lead-in, and each leg's **length + speed curve** (constant / accelerate / decelerate / smooth).
- **drop vs reveal (s)** — shifts the music drop relative to the reveal (`config.music.dropVsReveal`).
- **Lamp** intensities + colour, **Volumetric** density / steps / max-dist, button flicker.
- Replay (reload), Reset (factory defaults), Copy JSON.

In `?tune`, saved localStorage values override the baked defaults; **Reset** restores them. Production (no `?tune`) always uses the baked config.

> Verification gotcha: the Claude Preview tab parks `requestAnimationFrame`, so the intro freezes mid-play. To scrub a beat: `window.__intro._S.a = <0..1>; window.__tv._render()`. Audio/timeline state is inspectable via `window.__audio`, `window.__startIntroAudio`, `window.__primeAudio`.

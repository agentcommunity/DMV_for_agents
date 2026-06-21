import * as THREE from 'three';
import { createVolumetricPass } from './volumetric-pass.js?v=3';

const gsap = window.gsap;

// Cinematic "video mode" intro — a slow warm sunrise reveal of the TV scene.
//
// Black → the CRT power button flickers on/off/on/off for ~1.5s (a faulty old
// button warming up) → a warm Edison-toned "lamp" rises like a SUNRISE from
// behind the monitor (stationary at first, just glowing up), then slowly arcs
// up and over the top to the front, always focused on the monitor centre, so
// the front is progressively revealed. The light SOURCE is never shown — only
// what it lands on (the lit ledge + the monitor's outline). Then everything
// fades to black and the normal flat-lit scene loads.
//
// Framed at the EXACT default landing camera pose (same zoom) for a seamless
// hand-off. NO postprocessing — a real shadow-mapped SpotLight on the existing
// scene. During the intro the cyclorama BACK WALL is clipped away and the kiosk
// wall sign is hidden; both return with the normal scene at the end.
//
// All tunables live in this.config (owned by app.js, defaulted below). Pass
// `config: introConfig` in the opts to drive everything from one source; edit
// introConfig before play() / call rebuild() to change the look live.

// Curve name → GSAP ease map for config.timing.*Curve values.
const EASE = {
  constant:    'none',
  accelerate:  'power2.in',
  decelerate:  'power2.out',
  smooth:      'sine.inOut',
};

// Default config — matches the prototype-approved look exactly.
// app.js owns the live copy; this default lets Intro work standalone.
const DEFAULT_CONFIG = {
  flicker: {
    type: 'struggle',
    keyframes: [
      [0.00, 0.0, 0.01],
      [0.12, 0.30],
      [0.24, 0.0],
      [0.50, 0.60],
      [0.62, 0.04],
      [0.86, 1.00],
      [0.96, 0.10],
    ],
    catchAt: 1.12,
    catchDur: 0.32,
  },
  beats: { POWER: 0.30 },   // when the CRT button flicker begins (s). The old SUNRISE/ARC/FADE/BLACK/END beats are gone — the 4-leg `timing` model below derives all of those now.
  timing: {
    leadIn:  0.95,              // ① seconds of dark AFTER the button catches, before first light
    aBehind: 0.30,              // a-value where leg ② (sunrise/behind) ends and leg ③ (rise) begins
    aTop:    0.65,              // a-value where leg ③ (rise) ends and leg ④ (crest) begins
    sunrise: { length: 5.7, curve: 'smooth'     }, // ② a:0→aBehind + exposure brighten
    rise:    { length: 4.8, curve: 'constant'   }, // ③ a:aBehind→aTop (behind → over the top)
    crest:   { length: 3.5, curve: 'decelerate' }, // ④ a:aTop→1      (top → front = reveal)
    fadeLength:   0.85,
    revealLength: 0.90,
  },
  lamp: { color: '#ffb86b', initialIntensity: 0.52, midIntensity: 1.56, finalIntensity: 2.60 },
  vol:  { density: 1.8, intensity: 2.0, steps: 96, maxDist: 50 },
  dark: true,
  music: { dropAt: 14.85, dropVsReveal: 0 },  // music synced so the track's drop (dropAt s) lands on the reveal; dropVsReveal nudges it (s).
  signRevealDelay: 1.0,   // seconds AFTER the scene reveals before the wall sign stutters in
};

// The lamp aims here — the monitor centre. Passed to createVolumetricPass as its
// arc/aim subject so the volumetric DirectionalLight focuses the same focal point
// the old SpotLight arc did. (The arc radius/angles now live inside the pass.)
const SUBJECT = new THREE.Vector3(0, 0.25, 0.4);
const LAMP_COLOR = 0xffb86b; // warm Edison amber
const BTN_DAY = 0x33ff88;    // CRT power-button colour (day palette)
const C_BLACK = new THREE.Color(0x000000);

export class Intro {
  constructor(tv, opts = {}) {
    this.tv = tv;
    this.scene = tv.getScene();
    this.renderer = tv.renderer;
    this.wallSign = opts.wallSign || null;
    this.overlay = opts.overlay || document.getElementById('introOverlay');
    // config owns ALL tunables; app.js passes its live introConfig here.
    // Deep-copy the default so standalone usage never mutates the constant.
    this.config = opts.config || JSON.parse(JSON.stringify(DEFAULT_CONFIG));

    this.onStart = null;
    this.onReveal = null;

    this._done = false;
    this._sceneRestored = false;
    this._tl = null;
    this._barAmt = 1;
    this._blackAmt = 0;

    this._S = { a: 0 };

    this._restore = {
      ambient: tv.ambientLight ? tv.ambientLight.intensity : 0.5,
      point: tv.pointLight ? tv.pointLight.intensity : 0.5,
      fog: this.scene.fog,
      exposure: tv.toneMappingExposureMax != null ? tv.toneMappingExposureMax : 3.0,
      triggerColor: tv.triggerEl ? tv.triggerEl.material.color.clone() : null,
    };
    this._grayClear = new THREE.Color(tv.fogColor);

    let lookY = 0.5;
    try { lookY = tv._getScrollEndCameraState().lookY; } catch { /* default */ }
    this._endLookY = lookY;

    this._renderCb = () => this._tick();
    this._shadowMeshes = [];

    this._build();
  }

  // ── Rig construction ──────────────────────────────────────────────

  _build() {
    const rig = new THREE.Group();
    rig.name = 'introRig';
    this.rig = rig;
    this.scene.add(rig);

    // Use the EXACT existing scene: the real cyclorama/ledge is the shadow
    // receiver (no stand-in → no jump). Clip the BACK WALL away so we keep only
    // the ledge + its front panel against a black void (the cyclorama is one
    // fused mesh). Clip removed under the black at the end.
    this._cyclorama = this.scene.getObjectByName('Plane');
    if (this._cyclorama) {
      this._cycloramaRecv = this._cyclorama.receiveShadow;
      this._cyclorama.receiveShadow = true;
      this._clipWasEnabled = this.renderer.localClippingEnabled;
      this.renderer.localClippingEnabled = true;
      this._clipPlaneSaved = this._cyclorama.material.clippingPlanes;
      this._cyclorama.material.clippingPlanes = [
        new THREE.Plane(new THREE.Vector3(0, -1, 0), -1.9),  // remove the high BACK WALL, keep the ledge
        // remove the FAR/back of the ledge surface (the unlit strip that receded toward the wall and
        // read as a black gap during the backlit phases) so the warm haze fills that band instead.
        // Keeps z >= -0.2 (the front ledge under/before the monitor, where the shadow shaft lands).
        new THREE.Plane(new THREE.Vector3(0, 0, 1), 0.2),
      ];
    }

    // Hide the kiosk wall sign during the intro (its depth-writing plate would
    // punch a black rectangle into the scene as the light rises). Returns with
    // the normal scene.
    if (this.wallSign && this.wallSign.mesh) {
      this._wallSignVis = this.wallSign.mesh.visible;
      this.wallSign.mesh.visible = false;
    }

    for (const name of ['Cube', 'Cube007', 'Cube006', 'Rubber', 'Glass']) {
      const m = this.scene.getObjectByName(name);
      if (!m) continue;
      m.castShadow = true;
      m.receiveShadow = true;
      this._shadowMeshes.push(m);
    }

    this.tv.introActive = true;
    this.renderer.setClearColor(C_BLACK, 1);
    this.renderer.toneMappingExposure = 0.42;
    if (this.tv.ambientLight) this.tv.ambientLight.intensity = 0;
    if (this.tv.pointLight) this.tv.pointLight.intensity = 0;
    if (this.tv.triggerEl) this.tv.triggerEl.material.color.setHex(0x000000);

    // The lamp — a real volumetric god-ray pass (shadow-casting DirectionalLight +
    // a full-screen ray-march composited over the scene render target). We never
    // render the source; only the lit air + what it lands on. Aim it at the same
    // SUBJECT the old SpotLight arc targeted so the monitor stays the focal point.
    this.pass = createVolumetricPass(THREE, { subject: SUBJECT });
    this.scene.add(this.pass.group);
    this.tv.setVolumetricPass(this.pass);
    // The main scene (GLB) is already present by the time the intro is built, so
    // the shadow map will be live on the first two-pass frame. TV also guards on
    // `_sceneRT`, so flipping ready here is safe.
    this.pass.setReady(true);
    this.pass.driveArc(this._S.a, this._volParams()); // seat the lamp at the arc start

    if (this.tv.camera) {
      this.tv.camera.position.set(0, -0.5, 20);
      this.tv.camera.lookAt(0, this._endLookY, 0);
    }

    this._applyBars();
    this._applyFade();
  }

  // ── Helpers ───────────────────────────────────────────────────────

  // Build the driveArc params from current config (called every frame + at build time, so live
  // ?tune edits take effect immediately). Reuses ONE object (no per-frame allocation) and forwards
  // the lamp intensities so the ?tune sliders actually reach driveArc (which otherwise falls back
  // to these same baked values).
  _volParams() {
    const { vol, lamp } = this.config;
    const p = this._arcParams || (this._arcParams = {});
    p.density = vol.density;
    p.intensity = vol.intensity;
    p.steps = vol.steps;
    p.maxDist = vol.maxDist;
    p.color = lamp.color;
    p.initialIntensity = lamp.initialIntensity;
    p.midIntensity = lamp.midIntensity;
    p.finalIntensity = lamp.finalIntensity;
    return p;
  }

  // ── Playback ──────────────────────────────────────────────────────

  play() {
    if (this.overlay) {
      this.overlay.hidden = false;
      this.overlay.classList.add('is-playing');
      const skip = this.overlay.querySelector('#introSkip');
      if (skip) skip.addEventListener('click', (e) => { e.stopPropagation(); this.skip(); });
    }
    this.tv.onRender(this._renderCb);

    return new Promise((resolve) => {
      this._resolve = resolve;
      this._tl = this._buildTimeline();
    });
  }

  // Factor the GSAP timeline construction into a helper so both play() and
  // rebuild() use the same code path. Reads from this.config at call time.
  _buildTimeline() {
    const S = this._S;
    const BEAT = this.config.beats;
    const POWER = BEAT.POWER;
    // config.timing owns the four-leg lamp sequence. Fall back to safe defaults for
    // stale localStorage blobs that pre-date the 4-leg model.
    const T = this.config.timing || {};
    const leadIn    = T.leadIn    != null ? T.leadIn    : 0.4;
    const aBehind   = T.aBehind   != null ? T.aBehind   : 0.30;
    const aTop      = T.aTop      != null ? T.aTop      : 0.65;
    const sunrise   = T.sunrise   || { length: 2.5, curve: 'decelerate' };
    const rise      = T.rise      || { length: 3.5, curve: 'constant'   };
    const crest     = T.crest     || { length: 3.5, curve: 'decelerate' };
    const fadeLength   = T.fadeLength   != null ? T.fadeLength   : 0.85;
    const revealLength = T.revealLength != null ? T.revealLength : 0.90;

    const sunriseCurve = EASE[sunrise.curve] || 'power2.out';
    const riseCurve    = EASE[rise.curve]    || 'none';
    const crestCurve   = EASE[crest.curve]   || 'power2.out';

    // ① Lead-in: button catches at POWER + catchAt, then dark silence for leadIn seconds.
    const firstLight = POWER + (this.config.flicker.catchAt ?? 1.12) + leadIn;

    // The fade/black/end are DERIVED from the arc end + durations so that changing leg
    // lengths stretches the WHOLE timeline.
    const ARC_END    = firstLight + sunrise.length + rise.length + crest.length;
    const FADE_START = ARC_END + 0.20;             // brief hold at full arc, then fade
    const BLACK      = FADE_START + fadeLength;
    const REVEAL_DONE = BLACK + 0.05 + revealLength;
    // Wall sign stutters in a beat AFTER the scene has settled, not during the reveal.
    const SIGN_DELAY  = this.config.signRevealDelay != null ? this.config.signRevealDelay : 1.0;
    const SIGN_REVEAL = REVEAL_DONE + SIGN_DELAY;
    // The letterbox bars hold until the wall-sign stutter FINISHES, then clear.
    const SIGN_FLICKER = (this.wallSign && this.wallSign.flickerDuration) || 1.8;
    const END         = SIGN_REVEAL + SIGN_FLICKER + 0.9;  // flicker done → 0.6s letterbox open → buffer
    const tl = gsap.timeline({ onComplete: () => this._finalize() });

    // Crack the shutter to letterbox right away so the button flicker is
    // visible (in an open frame, not behind a closed shutter).
    tl.to(this, { _barAmt: 0.28, duration: 0.6, ease: 'expo.out',
      onUpdate: () => this._applyBars() }, 0.1);
    if (this.overlay) tl.call(() => this.overlay.classList.add('is-lit'), null, 0.2);

    // POWER — the CRT button flickers on, then the music. The music is SYNCED TO THE REVEAL, not the
    // sunrise: it starts so its loud drop (config.music.dropAt seconds into the track) lands exactly when
    // the default white light floods in — REVEAL_LIGHT, the instant the black starts lifting to show the
    // normal scene (= BLACK + 0.05, matching the reveal tween below) — nudged by config.music.dropVsReveal
    // (0 = on the reveal, + = later). Deriving from REVEAL_LIGHT means the drop auto-tracks any leg retune.
    this._addButtonFlicker(tl, POWER);
    const M = this.config.music || {};
    const dropAt = typeof M.dropAt === 'number' ? M.dropAt : 14.85;
    const dropVsReveal = typeof M.dropVsReveal === 'number' ? M.dropVsReveal : 0;
    const REVEAL_LIGHT = BLACK + 0.05;
    const musicAt = Math.max(0, REVEAL_LIGHT - dropAt + dropVsReveal);
    tl.call(() => { if (this.onStart) this.onStart(); }, null, musicAt);

    // ② SUNRISE leg — exposure brightens + lamp moves a:0→aBehind (still behind, glowing up).
    tl.fromTo(this.renderer, { toneMappingExposure: 0.42 },
      { toneMappingExposure: 3.0, duration: sunrise.length, ease: sunriseCurve }, firstLight);
    tl.to(S, { a: aBehind, duration: sunrise.length, ease: sunriseCurve }, firstLight);

    // ③ RISE leg — lamp moves a:aBehind→aTop (behind → over the top).
    tl.to(S, { a: aTop, duration: rise.length, ease: riseCurve },
      firstLight + sunrise.length);

    // ④ CREST leg — lamp moves a:aTop→1 (top → front = reveal).
    tl.to(S, { a: 1, duration: crest.length, ease: crestCurve },
      firstLight + sunrise.length + rise.length);

    // FADE TO BLACK — the DOM black layer covers; we do NOT tween exposure here
    // (it would race the exposure restore in _restoreScene and could leave the
    // revealed scene black). The lamp/beam stay at full and are torn down with
    // the pass under the black.
    tl.to(this, { _blackAmt: 1, duration: fadeLength, ease: 'power2.in',
      onUpdate: () => this._applyFade() }, FADE_START);

    // FULL BLACK — restore the exact normal scene under cover (wall sign NOT yet lit).
    tl.call(() => { this._restoreScene(); }, null, BLACK);

    // REVEAL — lift the black; the normal flat-lit scene is underneath. The letterbox
    // bars STAY (we no longer clear the overlay here).
    tl.to(this, { _blackAmt: 0, duration: revealLength, ease: 'power2.out',
      onUpdate: () => this._applyFade() }, BLACK + 0.05);

    // WALL SIGN — stutters in a beat after the scene settles (its own GSAP flicker). The
    // letterbox bars HOLD until that stutter FINISHES, then the letterbox opens smoothly
    // (driven by the flicker's onDone, since the flicker is its own GSAP timeline).
    tl.call(() => {
      if (this.onReveal) {
        this.onReveal(() => {
          if (this.overlay) this.overlay.classList.add('is-clearing'); // fade grain/vignette/skip/sound
          gsap.to(this, { _barAmt: 0, duration: 0.6, ease: 'power2.inOut',
            onUpdate: () => this._applyBars() });                       // open the letterbox
        });
        this.onReveal = null;
      }
    }, null, SIGN_REVEAL);

    // Hold the timeline open to END (after the stutter + bar clear) so onComplete fires last.
    tl.to({}, { duration: 0.01 }, END);

    return tl;
  }

  // Kill the current GSAP timeline and rebuild+replay it from the current
  // this.config. The volumetric pass and render target are NOT recreated —
  // they persist across rebuilds (assumption: pass is still attached to TV).
  // driveArc() picks up config changes immediately on the next frame tick.
  // If the intro has already finished (_done is true) rebuild() is a no-op
  // beyond resetting the arc position — the panel re-arms separately.
  rebuild() {
    if (this._tl) this._tl.kill();
    this._tl = null;

    // Reset timeline-driven state to pre-play values.
    this._S.a = 0;
    this._barAmt = 1;
    this._blackAmt = 0;
    this._applyBars();
    this._applyFade();
    if (this.renderer) this.renderer.toneMappingExposure = 0.42;
    if (this.pass) this.pass.driveArc(0, this._volParams());

    // Reset the _done / _sceneRestored flags so _buildTimeline's onComplete
    // (_finalize → _restoreScene) can run again. Only safe to do here because
    // the pass is still alive (we only call rebuild before the intro ends).
    this._done = false;
    this._sceneRestored = false;

    this._tl = this._buildTimeline();
  }

  // CRT power button warm-up: a couple of struggling attempts (each a little
  // stronger) that blink out, then it catches and holds steady — like an old
  // button finally powering on. ~1.4s.
  _addButtonFlicker(tl, at) {
    const btn = this.tv.triggerEl;
    if (!btn) return;
    const g = new THREE.Color(BTN_DAY);
    const p = { f: 0 };
    const upd = () => btn.material.color.setRGB(g.r * p.f, g.g * p.f, g.b * p.f);
    const cfg = this.config.flicker;
    const set = (t, f, d = 0.06) => tl.to(p, { f, duration: d, ease: 'none', onUpdate: upd }, at + t);
    // Drive keyframes from config; each entry is [t, f] or [t, f, d].
    for (const kf of cfg.keyframes) {
      set(kf[0], kf[1], kf[2] !== undefined ? kf[2] : 0.06);
    }
    // Final catch — holds steady.
    tl.to(p, { f: 1.0, duration: cfg.catchDur, ease: 'power2.out', onUpdate: upd }, at + cfg.catchAt);
  }

  skip() {
    if (this._done) return;
    if (this._tl) this._tl.kill();
    this._S.a = 1;
    this._barAmt = 0; this._applyBars();
    this._blackAmt = 0; this._applyFade();
    if (this.onReveal) { this.onReveal(); this.onReveal = null; }
    this._finalize();
  }

  // ── Per-frame ─────────────────────────────────────────────────────

  _tick() {
    if (this._done) return;
    const a = this._S.a;

    // Drive the volumetric lamp arc from the GSAP-tweened arc value. driveArc owns
    // the DirectionalLight position/intensity + the beam uniforms; TV.js calls
    // updateUniforms() + renders the full-screen pass AFTER this tick (its two-pass
    // branch runs in _render, after the render-callback loop).
    if (this.pass) this.pass.driveArc(a, this._volParams());

    if (this.tv.camera) this.tv.camera.lookAt(0, this._endLookY, 0);
  }

  // ── Cleanup ───────────────────────────────────────────────────────

  _restoreScene() {
    if (this._sceneRestored) return;
    this._sceneRestored = true;

    this.renderer.setClearColor(this._grayClear, 1);
    this.renderer.toneMappingExposure = this._restore.exposure;
    if (this.tv.ambientLight) this.tv.ambientLight.intensity = this._restore.ambient;
    if (this.tv.pointLight) this.tv.pointLight.intensity = this._restore.point;
    this.scene.fog = this._restore.fog;
    if (this.tv.triggerEl && this._restore.triggerColor) {
      this.tv.triggerEl.material.color.copy(this._restore.triggerColor);
    }
    if (this._cyclorama) {
      this._cyclorama.receiveShadow = this._cycloramaRecv || false;
      this._cyclorama.material.clippingPlanes = this._clipPlaneSaved || null;
    }
    if (this._clipWasEnabled !== undefined) {
      this.renderer.localClippingEnabled = this._clipWasEnabled;
    }
    if (this.wallSign && this.wallSign.mesh) {
      this.wallSign.mesh.visible = this._wallSignVis !== undefined ? this._wallSignVis : true;
    }
    for (const m of this._shadowMeshes) { m.castShadow = false; m.receiveShadow = false; }
    this._shadowMeshes = [];

    if (this.tv.camera) {
      this.tv.camera.position.set(0, -0.5, 20);
      this.tv.camera.lookAt(0, this._endLookY, 0);
    }
    this.tv.mouseTarget.set(0, 0);
    this.tv.progress = 0;
    this.tv.introActive = false;

    // Tear down the volumetric pass: detach it from TV's render seam (disposes
    // _sceneRT), release the pass's GPU resources, and remove its DirectionalLight
    // group from the scene. Idempotent via _sceneRestored, but null the handle too
    // so a stray double-call can't dispose twice.
    if (this.pass) {
      this.tv.setVolumetricPass(null);
      this.pass.dispose(); // also removes this.pass.group from its parent
      this.pass = null;
    }

    this.tv.offRender(this._renderCb);

    this._disposeRig();
  }

  _finalize() {
    if (this._done) return;
    this._done = true;
    this._restoreScene();

    if (this.overlay) {
      this.overlay.classList.remove('is-playing', 'is-lit', 'is-clearing');
      this.overlay.hidden = true;
      this.overlay.style.removeProperty('--intro-fade');
    }

    if (this._resolve) { const r = this._resolve; this._resolve = null; r(); }
  }

  _disposeRig() {
    if (!this.rig) return;
    // The rig is an empty marker Group — nothing is ever added to it (the lamp/DirectionalLight lives
    // in the volumetric pass, torn down in _restoreScene via this.pass.dispose()). Nothing to
    // traverse/dispose; just detach it.
    this.scene.remove(this.rig);
    this.rig = null;
  }

  // ── Overlay / DOM ─────────────────────────────────────────────────

  _applyBars() {
    if (!this.overlay) return;
    this.overlay.style.setProperty('--intro-bar', this._barAmt.toFixed(4));
  }

  _applyFade() {
    if (!this.overlay) return;
    this.overlay.style.setProperty('--intro-fade', this._blackAmt.toFixed(4));
  }
}

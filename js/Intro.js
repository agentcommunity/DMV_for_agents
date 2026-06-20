import * as THREE from 'three';
import { createVolumetricPass } from './volumetric-pass.js?v=2';

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
  beats: {
    POWER: 0.30,
    SUNRISE: 1.80,
    ARC_START: 3.55,
    ARC_DUR: 6.60,
    FADE_START: 10.35,
    FADE_DUR: 0.85,
    BLACK: 11.20,
    REVEAL_DUR: 0.90,
    END: 12.25,
  },
  lamp: { color: '#ffb86b' },
  vol:  { density: 1.8, intensity: 2.0, steps: 96, maxDist: 50 },
  dark: true,
  music: { startAt: 'SUNRISE' },
  signReveal: 'at_reveal',
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
    this.onSoundRequest = null;
    this.onReveal = null;

    this._done = false;
    this._sceneRestored = false;
    this._tl = null;
    this._t = 0;
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
    this._look = { x: 0, y: lookY, z: 0 };

    this._renderCb = (dt) => this._tick(dt);
    this._onOverlayClick = (e) => this._handleOverlayClick(e);
    this._shadowMeshes = [];
    this._gv1 = new THREE.Vector3();
    this._gv2 = new THREE.Vector3();

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
        new THREE.Plane(new THREE.Vector3(0, -1, 0), -1.9),
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
      this.tv.camera.lookAt(this._look.x, this._look.y, this._look.z);
    }

    this._applyBars();
    this._applyFade();
  }

  _smooth(x, e0, e1) {
    const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
    return t * t * (3 - 2 * t);
  }

  // ── Helpers ───────────────────────────────────────────────────────

  // Build the driveArc params object from current config (called each frame +
  // at build time so live edits to introConfig take effect immediately).
  _volParams() {
    const { vol, lamp } = this.config;
    return {
      density: vol.density,
      intensity: vol.intensity,
      steps: vol.steps,
      maxDist: vol.maxDist,
      color: lamp.color,
    };
  }

  // ── Playback ──────────────────────────────────────────────────────

  play() {
    if (this.overlay) {
      this.overlay.hidden = false;
      this.overlay.classList.add('is-playing');
      this.overlay.addEventListener('click', this._onOverlayClick);
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
    // The fade/black/end are DERIVED from the arc end + durations so that changing ARC_DUR
    // (or ARC_START) stretches the WHOLE timeline. If they were fixed absolute positions, a
    // longer arc would just be truncated by a fade that still fires at the same second.
    // Defaults reproduce the old absolutes exactly: 3.55+6.60=10.15 → FADE 10.35 → BLACK 11.20 → END 12.25.
    const ARC_END    = BEAT.ARC_START + BEAT.ARC_DUR;
    const FADE_START = ARC_END + 0.20;             // brief hold at full arc, then fade
    const BLACK      = FADE_START + BEAT.FADE_DUR;
    const END        = BLACK + BEAT.REVEAL_DUR + 0.15;
    const tl = gsap.timeline({ onComplete: () => this._finalize() });

    // Crack the shutter to letterbox right away so the button flicker is
    // visible (in an open frame, not behind a closed shutter).
    tl.to(this, { _barAmt: 0.28, duration: 0.6, ease: 'expo.out',
      onUpdate: () => this._applyBars() }, 0.1);
    if (this.overlay) tl.call(() => this.overlay.classList.add('is-lit'), null, 0.2);

    // POWER — the CRT button flickers on; music starts only AFTER it catches.
    this._addButtonFlicker(tl, BEAT.POWER);
    tl.call(() => { if (this.onStart) this.onStart(); }, null, BEAT.SUNRISE);

    // SUNRISE — the warm lamp glows up from behind, stationary (a stays 0). The
    // lamp brightness + volumetric density are now owned by driveArc(a); here we
    // only ramp pass-1 exposure to lift the scene out of black.
    tl.fromTo(this.renderer, { toneMappingExposure: 0.42 },
      { toneMappingExposure: 3.0, duration: 6.5, ease: 'power2.out' }, BEAT.SUNRISE);

    // ARC — the lamp starts MOVING (visible from the borders) and keeps
    // strengthening: behind → over the top → high in front. driveArc(a) reads
    // this tween every frame in _tick, so it drives both the lamp arc AND the
    // volumetric beam strength.
    tl.to(S, { a: 1, duration: BEAT.ARC_DUR, ease: 'sine.inOut' }, BEAT.ARC_START);

    // FADE TO BLACK — the DOM black layer covers; we do NOT tween exposure here
    // (it would race the exposure restore in _restoreScene and could leave the
    // revealed scene black). The lamp/beam stay at full and are torn down with
    // the pass under the black.
    tl.to(this, { _blackAmt: 1, duration: BEAT.FADE_DUR, ease: 'power2.in',
      onUpdate: () => this._applyFade() }, FADE_START);

    // FULL BLACK — restore the exact normal scene under cover; wall sign in.
    tl.call(() => { this._restoreScene(); if (this.onReveal) this.onReveal(); }, null, BLACK);

    // REVEAL — lift the black; the normal flat-lit scene is underneath.
    tl.to(this, { _blackAmt: 0, duration: BEAT.REVEAL_DUR, ease: 'power2.out',
      onUpdate: () => this._applyFade() }, BLACK + 0.05);
    if (this.overlay) {
      tl.call(() => this.overlay.classList.add('is-clearing'), null, BLACK);
    }

    tl.to({}, { duration: Math.max(0.1, END - (BLACK + 0.05 + BEAT.REVEAL_DUR)) });

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

  _tick(dt) {
    if (this._done) return;
    this._t += dt;
    const a = this._S.a;

    // Drive the volumetric lamp arc from the GSAP-tweened arc value. driveArc owns
    // the DirectionalLight position/intensity + the beam uniforms; TV.js calls
    // updateUniforms() + renders the full-screen pass AFTER this tick (its two-pass
    // branch runs in _render, after the render-callback loop).
    if (this.pass) this.pass.driveArc(a, this._volParams());

    if (this.tv.camera) this.tv.camera.lookAt(this._look.x, this._look.y, this._look.z);
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

    const cbs = this.tv._renderCallbacks;
    if (cbs) {
      const i = cbs.indexOf(this._renderCb);
      if (i >= 0) cbs.splice(i, 1);
    }

    this._disposeRig();
  }

  _finalize() {
    if (this._done) return;
    this._done = true;
    this._restoreScene();

    if (this.overlay) {
      this.overlay.removeEventListener('click', this._onOverlayClick);
      this.overlay.classList.remove('is-playing', 'is-lit', 'is-clearing');
      this.overlay.hidden = true;
      this.overlay.style.removeProperty('--intro-fade');
    }

    if (this._resolve) { const r = this._resolve; this._resolve = null; r(); }
  }

  _disposeRig() {
    if (!this.rig) return;
    // (The lamp/DirectionalLight lives in the volumetric pass, torn down in
    // _restoreScene via this.pass.dispose(). The rig has no children after Task 4.)
    this.scene.remove(this.rig);
    this.rig.traverse((obj) => {
      if (obj.geometry) obj.geometry.dispose();
      if (obj.material) {
        if (obj.material.map) obj.material.map.dispose();
        obj.material.dispose();
      }
    });
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

  _handleOverlayClick(e) {
    if (e.target.closest('#introSkip')) return;
    if (this.onSoundRequest) this.onSoundRequest();
  }
}

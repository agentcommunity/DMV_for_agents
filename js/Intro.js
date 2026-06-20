import * as THREE from 'three';

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

const BEAT = {
  POWER: 0.30,       // CRT button starts blinking on/off (~1.4s)
  SUNRISE: 1.80,     // lamp intensity begins to rise (behind, stationary)
  ARC_START: 3.55,   // lamp begins to MOVE on its arc (visible from the borders)
  ARC_DUR: 6.60,     // arc movement: behind → over the top → high in front
  FADE_START: 10.35, // arc done (front lit) → begin fade to black
  FADE_DUR: 0.85,
  BLACK: 11.20,      // fully black → restore the normal scene under cover
  REVEAL_DUR: 0.90,  // lift the black to show the normal scene
  END: 12.25,
};

const SUBJECT = new THREE.Vector3(0, 0.25, 0.4);
const ARC_R = 9.0;
const ARC_RY = 5.5;
const ARC_SIDE = 1.2;
const ARC_THETA0 = THREE.MathUtils.degToRad(206); // behind & low (horizon)
const ARC_THETA1 = THREE.MathUtils.degToRad(40);  // front & up, above viewpoint
const SUN_PEAK = 18;
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
    this._panelMats = [];
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

    // The glossy front bezel (Rubber) + bottom slab (Cube006) would catch a
    // specular reflection of the lamp before it's even in front. Make them
    // matte during the intro and restore the gloss only once the lamp is above.
    // (Rubber + Cube006 share one material — capture the original roughness
    // before matting, and dedupe so the shared material is handled once.)
    const seenMat = new Set();
    for (const name of ['Rubber', 'Cube006']) {
      const m = this.scene.getObjectByName(name);
      if (!m || !m.material || m.material.roughness === undefined) continue;
      if (seenMat.has(m.material)) continue;
      seenMat.add(m.material);
      this._panelMats.push({ mat: m.material, orig: m.material.roughness });
    }
    // Mild matte (not full) — enough to soften a flat front specular but still
    // let the edges catch a rim from the backlight.
    for (const p of this._panelMats) p.mat.roughness = 0.5;

    this.scene.fog = new THREE.FogExp2(0x000000, 0.02);

    this.tv.introActive = true;
    this.renderer.setClearColor(C_BLACK, 1);
    this.renderer.toneMappingExposure = 0.42;
    if (this.tv.ambientLight) this.tv.ambientLight.intensity = 0;
    if (this.tv.pointLight) this.tv.pointLight.intensity = 0;
    if (this.tv.triggerEl) this.tv.triggerEl.material.color.setHex(0x000000);

    // The lamp — a hard, focused, warm SpotLight. We never render the source;
    // only what it lands on.
    const sun = new THREE.SpotLight(LAMP_COLOR, 0);
    sun.angle = THREE.MathUtils.degToRad(38);
    sun.penumbra = 0.16;
    sun.decay = 0;
    sun.distance = 0;
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.near = 1;
    sun.shadow.camera.far = 60;
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.03;
    sun.shadow.radius = 1.6;
    sun.target.position.copy(SUBJECT);
    rig.add(sun, sun.target);
    this.sun = sun;
    this._placeSun(0);

    // A contained warm backlight halo sitting just behind the monitor. The
    // monitor occludes its core (depth-tested), so what shows is a glow wrapping
    // the monitor's edges — the backlit silhouette. It only appears during the
    // low sunrise and is gone before the lamp climbs, so it never reads as a
    // floating disc.
    this._sunGlow = new THREE.Sprite(new THREE.SpriteMaterial({
      map: this._radialTexture(256, 0.5), // a soft halo with a readable bright core
      color: LAMP_COLOR,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: true,
      toneMapped: false,
    }));
    rig.add(this._sunGlow);

    if (this.tv.camera) {
      this.tv.camera.position.set(0, -0.5, 20);
      this.tv.camera.lookAt(this._look.x, this._look.y, this._look.z);
    }

    this._applyBars();
    this._applyFade();
  }

  _placeSun(a) {
    const theta = ARC_THETA0 + (ARC_THETA1 - ARC_THETA0) * a;
    this.sun.position.set(
      SUBJECT.x + ARC_SIDE,
      SUBJECT.y + Math.sin(theta) * ARC_RY,
      SUBJECT.z + Math.cos(theta) * ARC_R
    );
  }

  _smooth(x, e0, e1) {
    const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
    return t * t * (3 - 2 * t);
  }

  // Radial glow texture for the backlit halo. hardness 0..1 keeps a brighter
  // core before the falloff.
  _radialTexture(size, hardness = 0.0) {
    const cv = document.createElement('canvas');
    cv.width = cv.height = size;
    const ctx = cv.getContext('2d');
    const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    const mid = 0.22 + hardness * 0.34;
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(mid * 0.6, 'rgba(255,255,255,0.82)');
    g.addColorStop(mid, 'rgba(255,255,255,0.2)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
    const tex = new THREE.CanvasTexture(cv);
    tex.encoding = THREE.sRGBEncoding;
    return tex;
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
      const S = this._S;
      const tl = gsap.timeline({ onComplete: () => this._finalize() });
      this._tl = tl;

      // Crack the shutter to letterbox right away so the button flicker is
      // visible (in an open frame, not behind a closed shutter).
      tl.to(this, { _barAmt: 0.28, duration: 0.6, ease: 'expo.out',
        onUpdate: () => this._applyBars() }, 0.1);
      if (this.overlay) tl.call(() => this.overlay.classList.add('is-lit'), null, 0.2);

      // POWER — the CRT button flickers on; music starts only AFTER it catches.
      this._addButtonFlicker(tl, BEAT.POWER);
      tl.call(() => { if (this.onStart) this.onStart(); }, null, BEAT.SUNRISE);

      // SUNRISE — the warm lamp glows up from behind, stationary (a stays 0).
      tl.fromTo(this.sun, { intensity: 0 },
        { intensity: 9, duration: BEAT.ARC_START - BEAT.SUNRISE, ease: 'power2.out' }, BEAT.SUNRISE);
      tl.fromTo(this.renderer, { toneMappingExposure: 0.42 },
        { toneMappingExposure: 3.0, duration: 6.5, ease: 'power2.out' }, BEAT.SUNRISE);

      // ARC — the lamp starts MOVING (visible from the borders) and keeps
      // strengthening: behind → over the top → high in front.
      tl.to(S, { a: 1, duration: BEAT.ARC_DUR, ease: 'sine.inOut' }, BEAT.ARC_START);
      tl.to(this.sun, { intensity: SUN_PEAK, duration: BEAT.ARC_DUR * 0.85, ease: 'power1.in' }, BEAT.ARC_START);

      // FADE TO BLACK — the lamp dies and the DOM black layer covers; we do NOT
      // tween exposure here (it would race the exposure restore in _restoreScene
      // and could leave the revealed scene black).
      tl.to(this.sun, { intensity: 0, duration: BEAT.FADE_DUR, ease: 'power2.in' }, BEAT.FADE_START);
      tl.to(this, { _blackAmt: 1, duration: BEAT.FADE_DUR, ease: 'power2.in',
        onUpdate: () => this._applyFade() }, BEAT.FADE_START);

      // FULL BLACK — restore the exact normal scene under cover; wall sign in.
      tl.call(() => { this._restoreScene(); if (this.onReveal) this.onReveal(); }, null, BEAT.BLACK);

      // REVEAL — lift the black; the normal flat-lit scene is underneath.
      tl.to(this, { _blackAmt: 0, duration: BEAT.REVEAL_DUR, ease: 'power2.out',
        onUpdate: () => this._applyFade() }, BEAT.BLACK + 0.05);
      if (this.overlay) {
        tl.call(() => this.overlay.classList.add('is-clearing'), null, BEAT.BLACK);
      }

      tl.to({}, { duration: Math.max(0.1, BEAT.END - (BEAT.BLACK + 0.05 + BEAT.REVEAL_DUR)) });
    });
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
    const set = (t, f, d = 0.06) => tl.to(p, { f, duration: d, ease: 'none', onUpdate: upd }, at + t);
    set(0.00, 0.0, 0.01);
    set(0.12, 0.30);  // first weak attempt
    set(0.24, 0.0);
    set(0.50, 0.60);  // second, stronger
    set(0.62, 0.04);
    set(0.86, 1.00);  // nearly there
    set(0.96, 0.10);
    tl.to(p, { f: 1.0, duration: 0.32, ease: 'power2.out', onUpdate: upd }, at + 1.12); // catch & hold
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
    this._placeSun(a);

    // The warm halo ORBITS the monitor following the lamp: behind it during the
    // sunrise (the backlit silhouette), then travelling up and over to the
    // front WITH the lamp. It fades in once the arc starts (no halo during the
    // initial sunrise) and never fades back out.
    if (this._sunGlow) {
      this._gv1.copy(this.sun.position).sub(SUBJECT).normalize();
      this._gv2.copy(SUBJECT).addScaledVector(this._gv1, 4.5); // orbit radius
      this._sunGlow.position.copy(this._gv2);
      const cam = this.tv.camera;
      const dist = cam ? this._gv2.distanceTo(cam.position) : 18;
      const s = dist * 0.5; // keep a roughly constant (large) on-screen size as it travels
      this._sunGlow.scale.set(s, s, 1);
      const k = Math.min(1, this.sun.intensity / SUN_PEAK);
      const vis = this._smooth(a, 0.0, 0.16); // fade in as the arc begins; no fade-out
      this._sunGlow.material.opacity = vis * (0.55 + 0.45 * k);
    }

    // Restore the bezel's gloss only once the lamp is above/front, so the panel
    // doesn't reflect the light before it gets there.
    if (this._panelMats.length) {
      const gloss = this._smooth(this._S.a, 0.45, 0.66);
      for (const p of this._panelMats) p.mat.roughness = 0.5 + (p.orig - 0.5) * gloss;
    }
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
    for (const p of this._panelMats) p.mat.roughness = p.orig;
    this._panelMats = [];

    if (this.tv.camera) {
      this.tv.camera.position.set(0, -0.5, 20);
      this.tv.camera.lookAt(0, this._endLookY, 0);
    }
    this.tv.mouseTarget.set(0, 0);
    this.tv.progress = 0;
    this.tv.introActive = false;

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
    if (this.sun) { this.sun.dispose?.(); this.sun = null; }
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

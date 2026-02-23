import * as THREE from 'three';
import { CardDNA, renderCard, setQREncoder, PALETTES, RARITIES, HOLOS, hexToRgb, withAlpha, CW, CH } from './card-draw.js?v=23';
import { generateQRMatrix } from './qr-encode.js?v=1';

// Wire QR encoder into card-draw before first render
setQREncoder(generateQRMatrix);

/* ═══════════════════════════════════════════════════════════════════
   HoloCard — DOM overlay card with CSS holo effects
   Replaces GLSL shader version with the exact same holo system
   as card-lab-v2.html (pokemon-cards-css style overlays).
   Hidden Three.js mesh kept for TV.js raycasting & zoom.
   ═══════════════════════════════════════════════════════════════════ */

// ─── Config ──────────────────────────────────────────────────────

const WORLD_H = 2.4;
const WORLD_W = WORLD_H * (CW / CH);

// Display size of DOM card (px) — 0.7x canvas resolution
const CARD_PX_W = CW * 0.7;
const CARD_PX_H = CH * 0.7;

// ─── Spring Physics (from card-lab-v2) ──────────────────────────

function clamp(v, min, max) { return Math.min(Math.max(v, min), max); }

function createSpring() {
  return {
    mx: 50, my: 50, angle: 130,
    bgX: 50, bgY: 50,
    rotX: 0, rotY: 0,
    opacity: 0,
    targetMx: 50, targetMy: 50, targetAngle: 130,
    targetBgX: 50, targetBgY: 50,
    targetRotX: 0, targetRotY: 0,
    targetOpacity: 0,
  };
}

// ─── HoloCard Class ─────────────────────────────────────────────

export class HoloCard {

  constructor(options = {}) {
    this.position = options.position || { x: 4, y: 1, z: -0.5 };
    this.rotationY = options.rotationY ?? -0.2;

    // --- Hidden Three.js mesh (for raycasting & zoom positioning) ---
    const geo = new THREE.PlaneGeometry(WORLD_W, WORLD_H);
    const mat = new THREE.MeshBasicMaterial({
      transparent: true,
      opacity: 0,
      side: THREE.FrontSide,
      depthWrite: false,
    });
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.position.set(this.position.x, this.position.y, this.position.z);
    this.mesh.rotation.y = this.rotationY;
    this.mesh.visible = false;

    // --- DOM elements ---
    this._domCreated = false;
    this.cardWrap = null;
    this.cardEl = null;
    this.canvas = null;

    // --- Animation state ---
    this.time = 0;
    this.baseY = this.position.y;
    this.spring = createSpring();
    this._interacting = false;
    this._visible = false;

    // --- Data ---
    this.formData = null;
    this.rarity = null;
    this._clickCb = null;

    // --- Projection helpers (pre-allocated to avoid per-frame GC) ---
    this._projVec = new THREE.Vector3();
    this._topVec = new THREE.Vector3();
    this._botVec = new THREE.Vector3();
  }

  // ─── Create DOM elements (once) ───

  _ensureDOM() {
    if (this._domCreated) return;
    this._domCreated = true;

    // Wrap
    this.cardWrap = document.createElement('div');
    this.cardWrap.className = 'holo-card-wrap';
    this.cardWrap.style.cssText = `
      position: fixed;
      pointer-events: none;
      z-index: 50;
      transform-origin: center center;
      display: none;
    `;

    // Card
    this.cardEl = document.createElement('div');
    this.cardEl.className = 'holo-card';
    this.cardEl.style.cssText = `
      width: ${CARD_PX_W}px;
      height: ${CARD_PX_H}px;
      pointer-events: auto;
    `;

    // Canvas
    this.canvas = document.createElement('canvas');
    this.canvas.width = CW;
    this.canvas.height = CH;
    this.cardEl.appendChild(this.canvas);

    // Holo overlays
    for (const cls of ['card-shine', 'card-glare', 'card-foil', 'card-sparkle']) {
      const div = document.createElement('div');
      div.className = cls;
      this.cardEl.appendChild(div);
    }

    this.cardWrap.appendChild(this.cardEl);
    document.body.appendChild(this.cardWrap);

    // Click handler
    this.cardEl.addEventListener('click', (e) => {
      e.stopPropagation();
      if (this._clickCb) this._clickCb();
    });

    // Mouse/touch interaction for spring tilt
    this.cardEl.addEventListener('mouseenter', () => { this._interacting = true; });
    this.cardEl.addEventListener('mousemove', (e) => {
      this._interacting = true;
      this._applyTilt(e.clientX, e.clientY);
    });
    this.cardEl.addEventListener('mouseleave', () => {
      this._interacting = false;
      this._resetSpring();
    });
    this.cardEl.addEventListener('touchstart', (e) => {
      this._interacting = true;
      const t = e.touches[0];
      if (t) this._applyTilt(t.clientX, t.clientY);
    }, { passive: true });
    this.cardEl.addEventListener('touchmove', (e) => {
      e.preventDefault();
      const t = e.touches[0];
      if (t) this._applyTilt(t.clientX, t.clientY);
    }, { passive: false });
    this.cardEl.addEventListener('touchend', () => {
      this._interacting = false;
      this._resetSpring();
    });
  }

  // ─── Holo type application (from card-lab-v2) ───

  _applyHoloType(dna) {
    this.cardEl.classList.remove('holo-rainbow', 'holo-prism', 'holo-aurora', 'holo-duochrome');
    const holoId = HOLOS[dna.holo].id;
    if (holoId !== 'rainbow') this.cardEl.classList.add('holo-' + holoId);
    this.cardEl.style.setProperty('--holo-intensity', RARITIES[dna.rarity].intensity);
    if (holoId === 'duochrome') {
      const pal = PALETTES[dna.palette];
      this.cardEl.style.setProperty('--duo-1', withAlpha(pal.pri, 0.5));
      this.cardEl.style.setProperty('--duo-2', withAlpha(pal.acc, 0.5));
    }
    const pal = PALETTES[dna.palette];
    this.cardWrap.style.setProperty('--card-glow', withAlpha(pal.glow, 0.1));
  }

  // ─── Spring tilt (from card-lab-v2) ───

  _applyTilt(clientX, clientY) {
    const rect = this.cardEl.getBoundingClientRect();
    const px = clamp((clientX - rect.left) / rect.width, 0, 1);
    const py = clamp((clientY - rect.top) / rect.height, 0, 1);
    const s = this.spring;
    s.targetRotY = (px - 0.5) * 40;
    s.targetRotX = (py - 0.5) * -40;
    s.targetAngle = Math.atan2(py - 0.5, px - 0.5) * (180 / Math.PI) + 90;
    s.targetBgX = 37 + (px * 26);
    s.targetBgY = 33 + (py * 34);
    s.targetMx = px * 100;
    s.targetMy = py * 100;
    s.targetOpacity = 1;
  }

  _resetSpring() {
    const s = this.spring;
    s.targetMx = 50;
    s.targetMy = 50;
    s.targetAngle = 130;
    s.targetBgX = 50;
    s.targetBgY = 50;
    s.targetRotX = 0;
    s.targetRotY = 0;
    s.targetOpacity = 0;
  }

  // ─── Project mesh world position to screen coords ───

  _projectToScreen(camera, renderer) {
    this._projVec.copy(this.mesh.position);
    this._projVec.project(camera);

    const w = renderer.domElement.clientWidth;
    const h = renderer.domElement.clientHeight;
    const rect = renderer.domElement.getBoundingClientRect();

    return {
      x: rect.left + (this._projVec.x * 0.5 + 0.5) * w,
      y: rect.top + (-this._projVec.y * 0.5 + 0.5) * h,
    };
  }

  // ─── Calculate apparent size of mesh on screen ───

  _projectScale(camera, renderer) {
    this._topVec.copy(this.mesh.position);
    this._topVec.y += WORLD_H / 2;
    this._botVec.copy(this.mesh.position);
    this._botVec.y -= WORLD_H / 2;

    this._topVec.project(camera);
    this._botVec.project(camera);

    const h = renderer.domElement.clientHeight;
    const screenH = Math.abs(this._topVec.y - this._botVec.y) * 0.5 * h;
    return screenH / CARD_PX_H;
  }

  // ════════════════════════════════════════════════════════════════
  //  PUBLIC API (compatible with app.js)
  // ════════════════════════════════════════════════════════════════

  addToScene(scene) {
    scene.add(this.mesh);
  }

  show(formData, instant = false) {
    this._ensureDOM();
    this.formData = formData;

    const dna = new CardDNA(formData.agentName || 'agent');
    const rarity = RARITIES[dna.rarity];
    this.rarity = rarity;

    // Render canvas
    renderCard(this.canvas, formData.agentName || 'agent', dna, {
      certId: formData.certificateId,
      accountType: formData.accountType,
    });

    // Apply holo type CSS classes
    this._applyHoloType(dna);

    // Show hidden mesh for raycasting
    this.mesh.visible = true;

    // Show DOM card
    this._visible = true;
    this.cardWrap.style.display = '';

    if (instant) {
      this.cardWrap.style.opacity = '1';
    } else {
      // Fade in
      this.cardWrap.style.opacity = '0';
      this.cardWrap.style.transition = 'opacity 1.2s ease-out';
      requestAnimationFrame(() => {
        this.cardWrap.style.opacity = '1';
      });
    }
  }

  /**
   * Call every frame via tv.onRender(). Handles bob, spring, and DOM positioning.
   * @param {number} dt — delta time in seconds
   * @param {THREE.Camera} camera — from TV.js
   * @param {THREE.WebGLRenderer} renderer — from TV.js
   */
  update(dt, camera, renderer) {
    if (!this.mesh.visible || !this._visible) return;
    this.time += dt;

    // Gentle vertical bob on the mesh (so projection follows)
    this.mesh.position.y = this.baseY + Math.sin(this.time * 0.8) * 0.04;

    // --- Spring physics (from card-lab-v2 animateHolo) ---
    const s = this.spring;
    const isActive = this._interacting;
    const t = this.time;

    // Idle sway when not interacting
    if (!isActive) {
      s.targetRotX = Math.sin(t * 0.3) * 1.5;
      s.targetRotY = Math.cos(t * 0.25) * 2;
      s.targetBgX = 50 + Math.sin(t * 0.2) * 3;
      s.targetBgY = 50 + Math.cos(t * 0.15) * 3;
      s.targetAngle = 130 + Math.sin(t * 0.1) * 10;
    }

    const lerpRate = isActive ? 0.15 : 0.04;
    s.mx += (s.targetMx - s.mx) * lerpRate;
    s.my += (s.targetMy - s.my) * lerpRate;
    s.angle += (s.targetAngle - s.angle) * lerpRate;
    s.bgX += (s.targetBgX - s.bgX) * lerpRate;
    s.bgY += (s.targetBgY - s.bgY) * lerpRate;
    s.rotX += (s.targetRotX - s.rotX) * lerpRate;
    s.rotY += (s.targetRotY - s.rotY) * lerpRate;
    s.opacity += (s.targetOpacity - s.opacity) * (isActive ? 0.12 : 0.06);

    const pointerFromCenter = clamp(
      Math.sqrt(Math.pow((s.mx - 50) / 50, 2) + Math.pow((s.my - 50) / 50, 2)),
      0, 1
    );

    // Apply CSS custom properties (same as card-lab-v2)
    const el = this.cardEl;
    el.style.transform = `rotateX(${s.rotX.toFixed(2)}deg) rotateY(${s.rotY.toFixed(2)}deg)`;
    el.style.setProperty('--mx', s.mx.toFixed(1) + '%');
    el.style.setProperty('--my', s.my.toFixed(1) + '%');
    el.style.setProperty('--angle', s.angle.toFixed(1) + 'deg');
    el.style.setProperty('--bg-x', s.bgX.toFixed(1) + '%');
    el.style.setProperty('--bg-y', s.bgY.toFixed(1) + '%');
    el.style.setProperty('--card-opacity', s.opacity.toFixed(3));
    el.style.setProperty('--pointer-from-center', pointerFromCenter.toFixed(3));
    el.style.setProperty('--pointer-from-left', (s.mx / 100).toFixed(3));
    el.style.setProperty('--pointer-from-top', (s.my / 100).toFixed(3));

    // --- Position DOM card to match mesh projection ---
    if (camera && renderer) {
      const screen = this._projectToScreen(camera, renderer);
      const scale = this._projectScale(camera, renderer);
      this.cardWrap.style.left = screen.x + 'px';
      this.cardWrap.style.top = screen.y + 'px';
      this.cardWrap.style.transform = `translate(-50%, -50%) scale(${scale.toFixed(4)})`;
    }
  }

  /**
   * Set pointer / tilt target from mouse or gyroscope (app.js compatibility).
   * When the mouse is NOT directly over the card, this drives subtle ambient tilt.
   */
  setPointer(nx, ny) {
    if (this._interacting) return; // Direct hover takes priority
    // Map normalized (-1..1) to spring targets for gentle ambient response
    const s = this.spring;
    s.targetRotY = clamp(nx, -1, 1) * 3;
    s.targetRotX = clamp(ny, -1, 1) * -3;
  }

  setVisible(visible) {
    if (!this._domCreated) return;
    this._visible = visible;
    this.cardWrap.style.display = visible ? '' : 'none';
    if (visible && this.formData) {
      this.mesh.visible = true;
    }
  }

  onClick(cb) {
    this._clickCb = cb;
  }

  getMesh() {
    return this.mesh;
  }

  toPNG() {
    return this.canvas ? this.canvas.toDataURL('image/png') : '';
  }

  getCanvas() {
    return this.canvas;
  }

  getRarity() {
    return this.rarity;
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
    if (this.cardWrap && this.cardWrap.parentNode) {
      this.cardWrap.parentNode.removeChild(this.cardWrap);
    }
  }
}

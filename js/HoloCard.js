import * as THREE from 'three';

/* ═══════════════════════════════════════════════════════════════════
   HoloCard — Holographic 3D Agent Identity Card
   Self-contained Three.js module. Only depends on Three.js.
   Optional: window.gsap for fade-in animation.
   ═══════════════════════════════════════════════════════════════════ */

// ─── Config ──────────────────────────────────────────────────────

const CW = 630, CH = 880;
const PAD = 24;
const WORLD_H = 2.4;
const WORLD_W = WORLD_H * (CW / CH);

const RARITIES = [
  { name: 'STANDARD',  pct: 60,  intensity: 0.25, accent: '#33ff88', rgb: [0.2, 1.0, 0.53] },
  { name: 'ENHANCED',  pct: 85,  intensity: 0.45, accent: '#33ddff', rgb: [0.2, 0.87, 1.0] },
  { name: 'RARE',      pct: 95,  intensity: 0.65, accent: '#ffaa33', rgb: [1.0, 0.67, 0.2] },
  { name: 'LEGENDARY', pct: 100, intensity: 0.85, accent: '#ff44ff', rgb: [1.0, 0.27, 1.0] },
];

const RARITY_LABELS = {
  STANDARD:  'STANDARD',
  ENHANCED:  '\u25C6 ENHANCED \u25C6',
  RARE:      '\u2605 RARE \u2605',
  LEGENDARY: '\u2726 LEGENDARY \u2726',
};

// ─── Utilities ───────────────────────────────────────────────────

function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function seededRand(seed) {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

// ─── Shaders ─────────────────────────────────────────────────────

const VERT = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vNormal;
  varying vec3 vViewDir;

  void main() {
    vUv = uv;
    vNormal = normalize(normalMatrix * normal);
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vViewDir = normalize(cameraPosition - wp.xyz);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const FRAG = /* glsl */ `
  uniform sampler2D uCard;
  uniform float uTime;
  uniform vec2 uPointer;
  uniform float uIntensity;
  uniform vec3 uAccent;
  uniform float uOpacity;

  varying vec2 vUv;
  varying vec3 vNormal;
  varying vec3 vViewDir;

  float hash21(vec2 p) {
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
  }

  float vnoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(hash21(i), hash21(i + vec2(1, 0)), f.x),
      mix(hash21(i + vec2(0, 1)), hash21(i + vec2(1, 1)), f.x),
      f.y
    );
  }

  vec3 hsv2rgb(float h, float s, float v) {
    vec4 K = vec4(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0);
    vec3 p = abs(fract(vec3(h) + K.xyz) * 6.0 - K.www);
    return v * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), s);
  }

  void main() {
    vec4 tex = texture2D(uCard, vUv);
    vec3 base = pow(tex.rgb, vec3(2.2));

    float va = dot(vNormal, vViewDir);

    // Rainbow phase — shifts with view angle, UV, pointer, time
    float phase = vUv.x * 2.5 + vUv.y * 1.8 + va * 4.0 + uTime * 0.08;
    phase += (uPointer.x + uPointer.y) * 0.3;
    vec3 rainbow = hsv2rgb(fract(phase), 0.75, 1.0);

    // Foil lines (horizontal + diagonal)
    float hLines = sin(vUv.y * 180.0 + va * 35.0) * 0.5 + 0.5;
    hLines = smoothstep(0.65, 1.0, hLines);
    float dLines = sin((vUv.x + vUv.y) * 100.0 + va * 25.0) * 0.5 + 0.5;
    dLines = smoothstep(0.78, 1.0, dLines);
    float foil = max(hLines * 0.8, dLines * 0.4);

    // Glare spotlight following pointer
    float glare = 1.0 - length(vUv - uPointer);
    glare = pow(max(glare, 0.0), 4.0);

    // Fresnel edge glow
    float fresnel = pow(1.0 - max(va, 0.0), 3.0);

    // Sparkle noise
    float sp = vnoise(vUv * 50.0 + uTime * 0.4) * vnoise(vUv * 70.0 - uTime * 0.3);
    sp = pow(max(sp, 0.0), 5.0) * 4.0;

    // Composite holographic overlay
    vec3 holo = rainbow * foil;
    holo += rainbow * fresnel * 0.25;
    holo += rainbow * sp * uIntensity;

    float str = uIntensity * (0.3 + glare * 0.7);
    vec3 overlay = clamp(holo * str, 0.0, 0.95);

    // Color-dodge blend
    vec3 result = base / (1.0 - overlay);

    // Glare highlight
    result += vec3(1.0, 0.98, 0.94) * glare * 0.12;

    // Accent tint on fresnel edges
    result += uAccent * fresnel * uIntensity * 0.15;

    // Subtle grain
    result += (hash21(vUv * 800.0 + uTime * 5.0) - 0.5) * 0.015;

    gl_FragColor = vec4(result, tex.a * uOpacity);
  }
`;

// ─── HoloCard Class ─────────────────────────────────────────────

export class HoloCard {

  /**
   * @param {Object} options
   * @param {Object} options.position  — { x, y, z } world position
   * @param {number} options.rotationY — base Y rotation in radians
   * @param {string} options.fontFamily — CSS font stack for card text
   */
  constructor(options = {}) {
    const rootStyle = getComputedStyle(document.documentElement);
    const cssMono = rootStyle.getPropertyValue('--floating-ui-font-mono').trim();
    this.position = options.position || { x: 4, y: 1, z: -0.5 };
    this.rotationY = options.rotationY ?? -0.2;
    this.font = options.fontFamily ||
      cssMono ||
      '"PPSupplyMono", "SF Mono", "Fira Code", "Courier New", monospace';

    // --- Canvases ---
    this.frontCanvas = document.createElement('canvas');
    this.frontCanvas.width = CW;
    this.frontCanvas.height = CH;
    this.frontCtx = this.frontCanvas.getContext('2d');

    this.backCanvas = document.createElement('canvas');
    this.backCanvas.width = CW;
    this.backCanvas.height = CH;
    this.backCtx = this.backCanvas.getContext('2d');

    // --- Textures ---
    this.frontTex = new THREE.CanvasTexture(this.frontCanvas);
    this.backTex = new THREE.CanvasTexture(this.backCanvas);

    // --- Shader materials ---
    this.frontMat = this._makeMaterial(this.frontTex);
    this.backMat = this._makeMaterial(this.backTex);

    // --- Meshes ---
    const geo = new THREE.PlaneGeometry(WORLD_W, WORLD_H);
    this.mesh = new THREE.Mesh(geo, this.frontMat);
    this.mesh.position.set(this.position.x, this.position.y, this.position.z);
    this.mesh.rotation.y = this.rotationY;
    this.mesh.visible = false;

    this.backMesh = new THREE.Mesh(geo.clone(), this.backMat);
    this.backMesh.visible = false;
    this._syncBack();

    // --- Animation state ---
    this.time = 0;
    this.baseY = this.position.y;
    this.baseRotY = this.rotationY;
    this.targetTilt = { x: 0, y: 0 };
    this.currentTilt = { x: 0, y: 0 };
    this._tmpVec = new THREE.Vector3();

    // --- Data ---
    this.formData = null;
    this.rarity = null;
  }

  // ─── Material factory ───

  _makeMaterial(tex) {
    return new THREE.ShaderMaterial({
      uniforms: {
        uCard:      { value: tex },
        uTime:      { value: 0 },
        uPointer:   { value: new THREE.Vector2(0.5, 0.5) },
        uIntensity: { value: 0.25 },
        uAccent:    { value: new THREE.Vector3(0.2, 1.0, 0.53) },
        uOpacity:   { value: 0 },
      },
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      toneMapped: true,
      side: THREE.FrontSide,
    });
  }

  // ─── Sync back mesh to front mesh ───

  _syncBack() {
    this.backMesh.position.copy(this.mesh.position);
    this.backMesh.rotation.copy(this.mesh.rotation);
    this.backMesh.rotation.y += Math.PI;
  }

  // ─── Rarity ───

  _computeRarity(certId) {
    const roll = fnv1a(certId || 'unknown') % 100;
    for (const r of RARITIES) {
      if (roll < r.pct) return r;
    }
    return RARITIES[0];
  }

  // ════════════════════════════════════════════════════════════════
  //  CANVAS DRAWING — FRONT
  // ════════════════════════════════════════════════════════════════

  _drawFront(data, r) {
    const ctx = this.frontCtx;
    const w = CW, h = CH, f = this.font;
    ctx.clearRect(0, 0, w, h);

    // Background
    ctx.fillStyle = '#0a0d0a';
    ctx.fillRect(0, 0, w, h);

    // Subtle background grid
    ctx.strokeStyle = '#0f130f';
    ctx.lineWidth = 0.5;
    for (let gx = PAD; gx < w - PAD; gx += 28) {
      ctx.beginPath(); ctx.moveTo(gx, PAD); ctx.lineTo(gx, h - PAD); ctx.stroke();
    }
    for (let gy = PAD; gy < h - PAD; gy += 28) {
      ctx.beginPath(); ctx.moveTo(PAD, gy); ctx.lineTo(w - PAD, gy); ctx.stroke();
    }

    // Borders
    ctx.strokeStyle = r.accent;
    ctx.lineWidth = 2;
    ctx.strokeRect(PAD, PAD, w - PAD * 2, h - PAD * 2);
    ctx.strokeStyle = '#1a5a3a';
    ctx.lineWidth = 1;
    ctx.strokeRect(PAD + 6, PAD + 6, w - PAD * 2 - 12, h - PAD * 2 - 12);

    // Corner brackets
    this._corners(ctx, PAD - 4, PAD - 4, w - PAD * 2 + 8, h - PAD * 2 + 8, r.accent);

    // Header
    const hy = PAD + 18;
    ctx.font = `bold 16px ${f}`;
    ctx.fillStyle = '#88ffcc';
    ctx.textBaseline = 'top';
    ctx.textAlign = 'center';
    ctx.fillText('DEPT. OF MACHINE VERIFICATION', w / 2, hy);

    // Header dividers
    const dv = hy + 28;
    ctx.fillStyle = r.accent;
    ctx.fillRect(PAD + 20, dv, w - PAD * 2 - 40, 1);
    ctx.fillStyle = '#1a5a3a';
    ctx.fillRect(PAD + 20, dv + 3, w - PAD * 2 - 40, 1);

    // Identicon
    const icoS = 240, icoX = (w - icoS) / 2, icoY = dv + 18;
    ctx.strokeStyle = '#1a5a3a';
    ctx.lineWidth = 1;
    ctx.strokeRect(icoX - 3, icoY - 3, icoS + 6, icoS + 6);
    this._identicon(ctx, icoX, icoY, icoS, fnv1a(data.agentName || 'agent'), r.accent);

    // Agent name
    const ny = icoY + icoS + 22;
    const agentName = (data.agentName || 'agent') + '.agent';
    ctx.font = `bold 30px ${f}`;
    ctx.fillStyle = '#33ff88';
    ctx.textAlign = 'left';
    ctx.shadowColor = '#33ff88';
    ctx.shadowBlur = 10;
    ctx.fillText(agentName, PAD + 20, ny);
    ctx.shadowBlur = 0;

    // Divider
    ctx.fillStyle = '#1a5a3a';
    ctx.fillRect(PAD + 20, ny + 38, w - PAD * 2 - 40, 1);

    // Cert ID
    const cy = ny + 54;
    ctx.font = `11px ${f}`;
    ctx.fillStyle = '#1a5a3a';
    ctx.fillText('CERTIFICATE ID', PAD + 20, cy);
    ctx.font = `bold 24px ${f}`;
    ctx.fillStyle = '#88ffcc';
    ctx.shadowColor = r.accent;
    ctx.shadowBlur = 6;
    ctx.fillText(data.certificateId || 'NOVA-000-000X', PAD + 20, cy + 20);
    ctx.shadowBlur = 0;

    // Type + Status
    const iy = cy + 60;
    ctx.font = `11px ${f}`;
    ctx.fillStyle = '#1a5a3a';
    ctx.fillText('TYPE', PAD + 20, iy);
    ctx.fillText('STATUS', PAD + 220, iy);
    ctx.font = `bold 14px ${f}`;
    ctx.fillStyle = '#88ffcc';
    ctx.fillText((data.accountType || data.type || 'individual').toUpperCase(), PAD + 20, iy + 18);
    ctx.fillStyle = r.accent;
    ctx.fillText('\u25CF VERIFIED', PAD + 220, iy + 18);

    // QR pattern
    const qy = iy + 50, qs = 110;
    this._qr(ctx, PAD + 20, qy, qs, fnv1a(data.certificateId || ''));

    // Metadata right of QR
    const mx = PAD + 20 + qs + 20;
    ctx.font = `11px ${f}`;
    ctx.fillStyle = '#1a5a3a';
    ctx.fillText('ISSUED', mx, qy + 8);
    ctx.font = `13px ${f}`;
    ctx.fillStyle = '#88ffcc';
    const now = new Date();
    ctx.fillText(
      `${now.getFullYear()}.${String(now.getMonth() + 1).padStart(2, '0')}.${String(now.getDate()).padStart(2, '0')}`,
      mx, qy + 24
    );
    ctx.font = `11px ${f}`;
    ctx.fillStyle = '#1a5a3a';
    ctx.fillText('EXPIRES', mx, qy + 50);
    ctx.font = `13px ${f}`;
    ctx.fillStyle = '#88ffcc';
    ctx.fillText('NEVER', mx, qy + 66);

    // Rarity badge
    ctx.font = `bold 15px ${f}`;
    ctx.fillStyle = r.accent;
    ctx.shadowColor = r.accent;
    ctx.shadowBlur = 10;
    ctx.textAlign = 'center';
    ctx.fillText(RARITY_LABELS[r.name], mx + 90, qy + qs - 10);
    ctx.shadowBlur = 0;
    ctx.textAlign = 'left';

    // Bottom divider
    const by = h - PAD - 46;
    ctx.fillStyle = r.accent;
    ctx.fillRect(PAD + 20, by, w - PAD * 2 - 40, 1);
    ctx.fillStyle = '#1a5a3a';
    ctx.fillRect(PAD + 20, by + 3, w - PAD * 2 - 40, 1);

    // Footer
    ctx.font = `12px ${f}`;
    ctx.fillStyle = '#1a5a3a';
    ctx.textAlign = 'center';
    ctx.fillText('dmv.agentcommunity.org', w / 2, by + 18);
    ctx.textAlign = 'left';

    // Scanlines
    ctx.fillStyle = 'rgba(0, 0, 0, 0.06)';
    for (let sy = 0; sy < h; sy += 3) ctx.fillRect(0, sy, w, 1);
  }

  // ════════════════════════════════════════════════════════════════
  //  CANVAS DRAWING — BACK
  // ════════════════════════════════════════════════════════════════

  _drawBack(data, r) {
    const ctx = this.backCtx;
    const w = CW, h = CH, f = this.font;
    ctx.clearRect(0, 0, w, h);

    // Background
    ctx.fillStyle = '#0a0d0a';
    ctx.fillRect(0, 0, w, h);

    // Dot matrix
    ctx.fillStyle = '#0f130f';
    for (let dx = PAD; dx < w - PAD; dx += 12) {
      for (let dy = PAD; dy < h - PAD; dy += 12) {
        ctx.beginPath();
        ctx.arc(dx, dy, 1, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // Borders
    ctx.strokeStyle = r.accent;
    ctx.lineWidth = 2;
    ctx.strokeRect(PAD, PAD, w - PAD * 2, h - PAD * 2);
    ctx.strokeStyle = '#1a5a3a';
    ctx.lineWidth = 1;
    ctx.strokeRect(PAD + 6, PAD + 6, w - PAD * 2 - 12, h - PAD * 2 - 12);
    this._corners(ctx, PAD - 4, PAD - 4, w - PAD * 2 + 8, h - PAD * 2 + 8, r.accent);

    // Large watermark
    ctx.font = `bold 90px ${f}`;
    ctx.fillStyle = '#111511';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('DMV', w / 2, h * 0.28);

    // Subtitle
    ctx.font = `14px ${f}`;
    ctx.fillStyle = '#1a5a3a';
    ctx.textBaseline = 'top';
    ctx.fillText('DEPARTMENT OF', w / 2, h * 0.28 + 55);
    ctx.fillText('MACHINE VERIFICATION', w / 2, h * 0.28 + 75);

    // Geometric divider
    const dy = h * 0.48;
    ctx.strokeStyle = '#1a5a3a';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(PAD + 40, dy); ctx.lineTo(w / 2 - 20, dy); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(w / 2 + 20, dy); ctx.lineTo(w - PAD - 40, dy); ctx.stroke();
    // Diamond
    ctx.strokeStyle = r.accent;
    ctx.beginPath();
    ctx.moveTo(w / 2, dy - 8); ctx.lineTo(w / 2 + 8, dy);
    ctx.lineTo(w / 2, dy + 8); ctx.lineTo(w / 2 - 8, dy);
    ctx.closePath(); ctx.stroke();

    // Terms
    const ty = dy + 30;
    ctx.font = `10px ${f}`;
    ctx.fillStyle = '#1a5a3a';
    const lines = [
      'This certificate verifies the identity of the',
      'named agent under DMV Protocol v2.1.',
      'Unauthorized use or duplication is prohibited.',
      '',
      'All data processed in accordance with the',
      'Machine Privacy Framework (MPF v2.1).',
      'Registration is non-transferable.',
    ];
    lines.forEach((l, i) => ctx.fillText(l, w / 2, ty + i * 18));

    // MRZ
    const my = h - PAD - 105;
    ctx.fillStyle = '#0d100d';
    ctx.fillRect(PAD + 15, my, w - PAD * 2 - 30, 65);
    ctx.strokeStyle = '#1a5a3a';
    ctx.strokeRect(PAD + 15, my, w - PAD * 2 - 30, 65);

    const name = (data.agentName || 'AGENT').toUpperCase();
    const cert = (data.certificateId || 'NOVA000000X').replace(/-/g, '');
    const pad36 = (s) => s + '<'.repeat(Math.max(0, 38 - s.length));
    ctx.font = `12px ${f}`;
    ctx.fillStyle = '#1a5a3a';
    ctx.textAlign = 'left';
    ctx.fillText(pad36(`P<DMV<${name}`), PAD + 25, my + 22);
    ctx.fillText(pad36(cert), PAD + 25, my + 44);

    // Footer
    ctx.font = `12px ${f}`;
    ctx.fillStyle = '#1a5a3a';
    ctx.textAlign = 'center';
    ctx.fillText('dmv.agentcommunity.org', w / 2, h - PAD - 22);
    ctx.textAlign = 'left';

    // Scanlines
    ctx.fillStyle = 'rgba(0, 0, 0, 0.06)';
    for (let sy = 0; sy < h; sy += 3) ctx.fillRect(0, sy, w, 1);
  }

  // ════════════════════════════════════════════════════════════════
  //  DRAWING HELPERS
  // ════════════════════════════════════════════════════════════════

  _identicon(ctx, x, y, size, seed, color) {
    const rand = seededRand(seed);
    const grid = 9;
    const cell = size / grid;
    const half = Math.ceil(grid / 2);

    ctx.fillStyle = '#060806';
    ctx.fillRect(x, y, size, size);

    // Build top-left quadrant, mirror 4-fold
    const cells = [];
    for (let gy = 0; gy < half; gy++) {
      cells[gy] = [];
      for (let gx = 0; gx < half; gx++) {
        cells[gy][gx] = rand() > 0.42;
      }
    }

    ctx.fillStyle = color;
    ctx.globalAlpha = 0.8;
    for (let gy = 0; gy < grid; gy++) {
      for (let gx = 0; gx < grid; gx++) {
        const sy = gy < half ? gy : grid - 1 - gy;
        const sx = gx < half ? gx : grid - 1 - gx;
        if (cells[sy] && cells[sy][sx]) {
          ctx.fillRect(x + gx * cell + 1, y + gy * cell + 1, cell - 2, cell - 2);
        }
      }
    }
    ctx.globalAlpha = 1.0;

    // Subtle border
    ctx.strokeStyle = color;
    ctx.globalAlpha = 0.3;
    ctx.lineWidth = 1;
    ctx.strokeRect(x, y, size, size);
    ctx.globalAlpha = 1.0;
  }

  _qr(ctx, x, y, size, seed) {
    const n = 21;
    const c = size / n;
    const rand = seededRand(seed);

    ctx.fillStyle = '#060806';
    ctx.fillRect(x - 2, y - 2, size + 4, size + 4);

    const dot = (mx, my) => ctx.fillRect(x + mx * c, y + my * c, c, c);

    // Finder patterns
    const finder = (fx, fy) => {
      ctx.fillStyle = '#33ff88';
      for (let i = 0; i < 7; i++) {
        dot(fx + i, fy); dot(fx + i, fy + 6);
        dot(fx, fy + i); dot(fx + 6, fy + i);
      }
      for (let i = 2; i < 5; i++)
        for (let j = 2; j < 5; j++) dot(fx + i, fy + j);
    };
    finder(0, 0);
    finder(n - 7, 0);
    finder(0, n - 7);

    // Timing
    ctx.fillStyle = '#1a5a3a';
    for (let i = 8; i < n - 8; i++) {
      if (i % 2 === 0) { dot(i, 6); dot(6, i); }
    }

    // Data
    ctx.fillStyle = '#33ff88';
    ctx.globalAlpha = 0.7;
    for (let my = 0; my < n; my++) {
      for (let mx = 0; mx < n; mx++) {
        if ((mx < 8 && my < 8) || (mx >= n - 7 && my < 8) || (mx < 8 && my >= n - 7)) continue;
        if (mx === 6 || my === 6) continue;
        if (rand() > 0.5) dot(mx, my);
      }
    }
    ctx.globalAlpha = 1.0;

    ctx.strokeStyle = '#1a5a3a';
    ctx.lineWidth = 1;
    ctx.strokeRect(x - 2, y - 2, size + 4, size + 4);
  }

  _corners(ctx, x, y, w, h, color) {
    const L = 25, T = 2;
    ctx.fillStyle = color;
    ctx.fillRect(x, y, L, T);           ctx.fillRect(x, y, T, L);
    ctx.fillRect(x + w - L, y, L, T);   ctx.fillRect(x + w - T, y, T, L);
    ctx.fillRect(x, y + h - T, L, T);   ctx.fillRect(x, y + h - L, T, L);
    ctx.fillRect(x + w - L, y + h - T, L, T); ctx.fillRect(x + w - T, y + h - L, T, L);
  }

  // ════════════════════════════════════════════════════════════════
  //  PUBLIC API
  // ════════════════════════════════════════════════════════════════

  /**
   * Add both meshes to a Three.js scene.
   */
  addToScene(scene) {
    scene.add(this.mesh);
    scene.add(this.backMesh);
  }

  /**
   * Draw the card and reveal it.
   * @param {Object} formData — { agentName, certificateId, accountType }
   * @param {boolean} instant — skip fade-in animation
   */
  show(formData, instant = false) {
    this.formData = formData;
    this.rarity = this._computeRarity(formData.certificateId);

    // Shader uniforms
    [this.frontMat, this.backMat].forEach(m => {
      m.uniforms.uIntensity.value = this.rarity.intensity;
      m.uniforms.uAccent.value.set(...this.rarity.rgb);
    });

    // Draw both faces
    this._drawFront(formData, this.rarity);
    this._drawBack(formData, this.rarity);
    this.frontTex.needsUpdate = true;
    this.backTex.needsUpdate = true;

    this.mesh.visible = true;
    this.backMesh.visible = true;

    if (instant) {
      this.frontMat.uniforms.uOpacity.value = 1;
      this.backMat.uniforms.uOpacity.value = 1;
      return;
    }

    // Animated fade-in
    const gsap = window.gsap;
    if (gsap) {
      const proxy = { o: 0 };
      gsap.to(proxy, {
        o: 1, duration: 1.2, ease: 'power2.out',
        onUpdate: () => {
          this.frontMat.uniforms.uOpacity.value = proxy.o;
          this.backMat.uniforms.uOpacity.value = proxy.o;
        },
      });
    } else {
      this.frontMat.uniforms.uOpacity.value = 1;
      this.backMat.uniforms.uOpacity.value = 1;
    }
  }

  /**
   * Call every frame. Handles bob, tilt, and shader time.
   * @param {number} dt — delta time in seconds
   */
  update(dt) {
    if (!this.mesh.visible) return;
    this.time += dt;

    // Shader time
    this.frontMat.uniforms.uTime.value = this.time;
    this.backMat.uniforms.uTime.value = this.time;

    // Gentle bob
    this.mesh.position.y = this.baseY + Math.sin(this.time * 0.8) * 0.04;

    // Spring-lerp tilt toward pointer
    this.currentTilt.x += (this.targetTilt.x - this.currentTilt.x) * 0.04;
    this.currentTilt.y += (this.targetTilt.y - this.currentTilt.y) * 0.04;

    this.mesh.rotation.x = this.currentTilt.y * 0.12;
    this.mesh.rotation.y = this.baseRotY + this.currentTilt.x * 0.12;

    // Map tilt to shader pointer (0..1)
    const px = 0.5 + this.currentTilt.x * 0.4;
    const py = 0.5 - this.currentTilt.y * 0.4;
    this.frontMat.uniforms.uPointer.value.set(px, py);
    this.backMat.uniforms.uPointer.value.set(1.0 - px, py);

    this._syncBack();
  }

  /**
   * Set pointer / tilt target from mouse or gyroscope.
   * @param {number} nx — normalized X, -1 (left) to 1 (right)
   * @param {number} ny — normalized Y, -1 (bottom) to 1 (top)
   */
  setPointer(nx, ny) {
    this.targetTilt.x = Math.max(-1, Math.min(1, nx));
    this.targetTilt.y = Math.max(-1, Math.min(1, ny));
  }

  /**
   * Primary mesh (for raycasting, zoom calculations).
   */
  getMesh() {
    return this.mesh;
  }

  /**
   * Export the front face as PNG data-URL.
   */
  toPNG() {
    return this.frontCanvas.toDataURL('image/png');
  }

  /**
   * Get computed rarity info.
   */
  getRarity() {
    return this.rarity;
  }

  /**
   * Clean up Three.js resources.
   */
  dispose() {
    this.frontTex.dispose();
    this.backTex.dispose();
    this.frontMat.dispose();
    this.backMat.dispose();
    this.mesh.geometry.dispose();
    this.backMesh.geometry.dispose();
  }
}

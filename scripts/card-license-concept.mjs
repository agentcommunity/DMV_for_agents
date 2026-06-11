// ═══════════════════════════════════════════════════════════════
//  CARD CONCEPT — "AGENT OPERATOR LICENSE"
//
//  Design exploration: a full ID-document treatment of the agent
//  card. NOT wired into production — the live renderer stays
//  js/card-draw.js + container/src/card-renderer.js. This script
//  reuses CardDNA/PALETTES from the container renderer so every
//  visual trait remains a pure function of the agent name.
//
//  Run (needs container deps):
//    cd container && pnpm install --ignore-workspace
//    node ../scripts/card-license-concept.mjs
//  PNGs land in /tmp/license-*.png
// ═══════════════════════════════════════════════════════════════

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { writeFileSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
const rendererPath = join(here, '..', 'container', 'src', 'card-renderer.js');
const qrPath = join(here, '..', 'container', 'src', 'qr-encode.js');

const {
  createCanvas, CardDNA, PALETTES, RARITIES, generateCertId, withAlpha, CW, CH,
} = await import(rendererPath);
const { generateQRMatrix } = await import(qrPath);

// ── Small local helpers (duplicated from the renderer, which doesn't
//    export them; a production integration would export + share) ──

function seededRand(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const FONT = 'PPSupplyMono'; // registered by the card-renderer import

// ── Identicon (same 9x9 4-fold-symmetric algorithm as production) ──
function drawIdenticon(ctx, x, y, size, seed, color1, color2) {
  const rand = seededRand(seed);
  const grid = 9, cell = size / grid, half = Math.ceil(grid / 2);
  const cells = [];
  for (let gy = 0; gy < half; gy++) {
    cells[gy] = [];
    for (let gx = 0; gx < half; gx++) cells[gy][gx] = rand() > 0.42;
  }
  for (let gy = 0; gy < grid; gy++) {
    for (let gx = 0; gx < grid; gx++) {
      const sy = gy < half ? gy : grid - 1 - gy;
      const sx = gx < half ? gx : grid - 1 - gx;
      if (cells[sy] && cells[sy][sx]) {
        const t = gy / grid;
        const [r1, g1, b1] = hexToRgb(color1);
        const [r2, g2, b2] = hexToRgb(color2);
        const r = r1 + (r2 - r1) * t, g = g1 + (g2 - g1) * t, b = b1 + (b2 - b1) * t;
        ctx.fillStyle = `rgba(${r | 0},${g | 0},${b | 0},0.92)`;
        ctx.fillRect(x + gx * cell + 1, y + gy * cell + 1, cell - 2, cell - 2);
      }
    }
  }
}

// ── Code 128B barcode (same tables as production) ──
const CODE128B_PAT = '212222,222122,222221,121223,121322,131222,122213,122312,132212,221213,221312,231212,112232,122132,122231,113222,123122,123221,223211,221132,221231,213212,223112,312131,311222,321122,321221,312212,322112,322211,212123,212321,232121,111323,131123,131321,112313,132113,132311,211313,231113,231311,112133,112331,132131,113123,113321,133121,313121,211331,231131,213113,213311,213131,311123,311321,331121,312113,312311,332111,314111,221411,431111,111224,111422,121124,121421,141122,141221,112214,112412,122114,122411,142112,142211,241211,221114,413111,241112,134111,111242,121142,121241,114212,124112,124211,411212,421112,421211,212141,214121,412121,111143,111341,131141,114113,114311,411113,411311,113141,114131,311141,411131,211412,211214,211232'.split(',');
const CODE128_STOP = '2331112';

function encodeCode128B(text) {
  const bars = [CODE128B_PAT[104]];
  let checksum = 104;
  for (let i = 0; i < text.length; i++) {
    const val = text.charCodeAt(i) - 32;
    if (val < 0 || val > 94) continue;
    bars.push(CODE128B_PAT[val]);
    checksum += val * (i + 1);
  }
  bars.push(CODE128B_PAT[checksum % 103]);
  bars.push(CODE128_STOP);
  return bars.join('');
}

function drawBarcode(ctx, x, y, w, h, text, color) {
  const encoded = encodeCode128B(text);
  let totalUnits = 20;
  for (let i = 0; i < encoded.length; i++) totalUnits += parseInt(encoded[i]);
  const unitW = w / totalUnits;
  let cx = x + 10 * unitW;
  ctx.fillStyle = color;
  for (let i = 0; i < encoded.length; i++) {
    const bw = parseInt(encoded[i]) * unitW;
    if (i % 2 === 0) ctx.fillRect(cx, y, Math.max(bw, 0.5), h);
    cx += bw;
  }
}

function drawQR(ctx, x, y, size, url, color) {
  const { matrix, size: n } = generateQRMatrix(url);
  const c = size / n;
  ctx.fillStyle = 'rgba(0,0,0,0.6)';
  ctx.fillRect(x - 3, y - 3, size + 6, size + 6);
  ctx.fillStyle = color;
  for (let my = 0; my < n; my++) {
    for (let mx = 0; mx < n; mx++) {
      if (matrix[my][mx]) ctx.fillRect(x + mx * c, y + my * c, c, c);
    }
  }
}

// ── Guilloche: interleaved sine-wave line bands (banknote texture) ──
function drawGuilloche(ctx, seed, pal) {
  const rand = seededRand(seed);
  ctx.save();
  for (let band = 0; band < 3; band++) {
    const baseY = 180 + band * 150 + rand() * 60;
    const amp = 26 + rand() * 30;
    const freq = 0.012 + rand() * 0.008;
    const phaseStep = 0.55 + rand() * 0.4;
    const lines = 7;
    const color = band === 1 ? pal.acc : pal.pri;
    for (let l = 0; l < lines; l++) {
      ctx.beginPath();
      ctx.strokeStyle = withAlpha(color, 0.045);
      ctx.lineWidth = 0.7;
      for (let x = 0; x <= CW; x += 4) {
        const y = baseY
          + Math.sin(x * freq + l * phaseStep) * amp
          + Math.sin(x * freq * 2.7 + l * 1.3) * (amp * 0.35);
        if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
  }
  ctx.restore();
}

// ── Microprint rule: a divider that is actually tiny repeated text ──
function drawMicroprint(ctx, x, y, w, pal) {
  ctx.save();
  ctx.font = `4.5px ${FONT}`;
  ctx.fillStyle = withAlpha(pal.pri, 0.55);
  const unit = 'DEPARTMENTOFMACHINEVERIFICATION•';
  const unitW = ctx.measureText(unit).width;
  let cx = x;
  while (cx < x + w) {
    ctx.fillText(unit, cx, y);
    cx += unitW;
  }
  ctx.restore();
}

// ── Machine signature: hash-seeded scrawl (decaying double-sine) ──
function drawSignature(ctx, x, y, w, seed, color) {
  const rand = seededRand(seed);
  const f1 = 0.055 + rand() * 0.03;
  const f2 = 0.13 + rand() * 0.06;
  const p1 = rand() * Math.PI * 2;
  const p2 = rand() * Math.PI * 2;
  const tilt = (rand() - 0.5) * 0.12; // slight baseline drift
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const [lw, alpha] of [[2.1, 0.9], [0.9, 0.45]]) {
    ctx.lineWidth = lw;
    ctx.globalAlpha = alpha;
    ctx.beginPath();
    for (let i = 0; i <= 60; i++) {
      const t = i / 60;
      const px = x + t * w;
      // tall initial letterform, settling into a scrawl that trails off
      const amp = 26 * (1 - t * 0.75) * (t < 0.06 ? t / 0.06 : 1);
      const py = y + t * w * tilt
        + Math.sin(px * f1 + p1) * amp
        + Math.sin(px * f2 + p2) * amp * 0.45;
      if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
    ctx.stroke();
  }
  // flourish underline
  ctx.globalAlpha = 0.65;
  ctx.lineWidth = 1.1;
  ctx.beginPath();
  ctx.moveTo(x + w * 0.08, y + 20);
  ctx.quadraticCurveTo(x + w * 0.5, y + 27 + (rand() - 0.5) * 6, x + w * 0.85, y + 15);
  ctx.stroke();
  ctx.restore();
}

// ── Round department seal (notary-stamp style) ──
function drawSeal(ctx, cx, cy, r, pal, tierSym) {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.strokeStyle = withAlpha(pal.pri, 0.42);
  ctx.lineWidth = 2;
  ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.stroke();
  ctx.lineWidth = 0.8;
  ctx.beginPath(); ctx.arc(0, 0, r - 5, 0, Math.PI * 2); ctx.stroke();
  ctx.beginPath(); ctx.arc(0, 0, r - 26, 0, Math.PI * 2); ctx.stroke();

  // circular text between the rings
  const text = '• DEPT. OF MACHINE VERIFICATION • .AGENT COMMUNITY ';
  ctx.font = `9px ${FONT}`;
  ctx.fillStyle = withAlpha(pal.pri, 0.5);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const step = (Math.PI * 2) / text.length;
  for (let i = 0; i < text.length; i++) {
    ctx.save();
    ctx.rotate(i * step - Math.PI / 2);
    ctx.translate(0, -(r - 15));
    ctx.fillText(text[i], 0, 0);
    ctx.restore();
  }

  // center: tier symbol + year
  ctx.fillStyle = withAlpha(pal.pri, 0.45);
  ctx.font = `26px ${FONT}`;
  ctx.fillText(tierSym || '✦', 0, -8);
  ctx.font = `10px ${FONT}`;
  ctx.fillText('EST. 2026', 0, 16);
  ctx.restore();
}

// ── The license itself ──
export function renderLicenseCard(canvas, name, opts = {}) {
  const ctx = canvas.getContext('2d');
  const dna = new CardDNA(name);
  const pal = PALETTES[dna.palette];
  const rarity = RARITIES[dna.rarity];
  const certId = opts.certId || generateCertId(name);
  const accountType = (opts.accountType || 'individual').toLowerCase();
  const permalink = `https://dmv.agentcommunity.org/c/${certId}/${name}`;

  const CLASS_BY_TYPE = {
    agent: 'A — AUTONOMOUS',
    individual: 'B — OPERATOR-BOUND',
    organization: 'C — FLEET',
  };

  // ── background ──
  const bg = ctx.createLinearGradient(0, 0, 0, CH);
  bg.addColorStop(0, pal.bg);
  bg.addColorStop(1, pal.bg2);
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, CW, CH);

  drawGuilloche(ctx, dna.patternSeed, pal);

  // ghost identicon (anti-counterfeit duplicate, behind the upper fields —
  // kept clear of the seal/signature corner so neither reads as noise)
  ctx.save();
  ctx.globalAlpha = 0.05;
  drawIdenticon(ctx, 596, 148, 186, dna.identiconSeed, pal.pri, pal.acc);
  ctx.restore();

  // ── header band ──
  const hdrH = 86;
  const hdr = ctx.createLinearGradient(0, 0, 0, hdrH);
  hdr.addColorStop(0, withAlpha(pal.pri, 0.13));
  hdr.addColorStop(1, withAlpha(pal.pri, 0.02));
  ctx.fillStyle = hdr;
  ctx.fillRect(0, 0, CW, hdrH);
  ctx.fillStyle = withAlpha(pal.pri, 0.5);
  ctx.fillRect(0, hdrH, CW, 1);

  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  ctx.font = `11px ${FONT}`;
  ctx.fillStyle = withAlpha(pal.sec, 0.6);
  ctx.fillText('D E P T .   O F   M A C H I N E   V E R I F I C A T I O N', 36, 32);

  ctx.font = `27px ${FONT}`;
  ctx.fillStyle = pal.pri;
  ctx.shadowColor = pal.glow;
  ctx.shadowBlur = 12;
  ctx.fillText('AGENT OPERATOR LICENSE', 36, 64);
  ctx.shadowBlur = 0;

  // tier chip (top right) — deterministic finish, not a prize
  const chipText = `${rarity.sym ? rarity.sym + ' ' : ''}${rarity.name}`;
  ctx.font = `12px ${FONT}`;
  const chipW = ctx.measureText(chipText).width + 24;
  const chipX = CW - 36 - chipW;
  ctx.strokeStyle = withAlpha(pal.pri, 0.55);
  ctx.lineWidth = 1;
  ctx.strokeRect(chipX, 22, chipW, 24);
  ctx.fillStyle = withAlpha(pal.pri, 0.08);
  ctx.fillRect(chipX, 22, chipW, 24);
  ctx.fillStyle = pal.pri;
  ctx.fillText(chipText, chipX + 12, 39);
  ctx.font = `9px ${FONT}`;
  ctx.fillStyle = withAlpha(pal.sec, 0.5);
  ctx.textAlign = 'right';
  ctx.fillText('PRE-REGISTRATION', CW - 36, 62);
  ctx.textAlign = 'left';

  // ── portrait (bearer image) ──
  const phX = 36, phY = 112, phW = 188, phH = 250;
  const backdrop = ctx.createLinearGradient(0, phY, 0, phY + phH);
  backdrop.addColorStop(0, 'rgba(0,0,0,0.55)');
  backdrop.addColorStop(1, withAlpha(pal.bgL, 0.9));
  ctx.fillStyle = backdrop;
  ctx.fillRect(phX, phY, phW, phH);
  // photo-booth backdrop lines
  ctx.strokeStyle = withAlpha(pal.pri, 0.06);
  ctx.lineWidth = 1;
  for (let ly = phY + 18; ly < phY + phH; ly += 18) {
    ctx.beginPath(); ctx.moveTo(phX, ly); ctx.lineTo(phX + phW, ly); ctx.stroke();
  }
  const iconSize = 144;
  ctx.save();
  ctx.shadowColor = pal.glow;
  ctx.shadowBlur = 18;
  drawIdenticon(ctx, phX + (phW - iconSize) / 2, phY + 38, iconSize, dna.identiconSeed, pal.pri, pal.acc);
  ctx.restore();
  ctx.strokeStyle = withAlpha(pal.pri, 0.55);
  ctx.lineWidth = 1;
  ctx.strokeRect(phX, phY, phW, phH);
  ctx.font = `8px ${FONT}`;
  ctx.fillStyle = withAlpha(pal.sec, 0.45);
  ctx.textAlign = 'center';
  ctx.fillText('BEARER IMAGE · MACHINE-GENERATED', phX + phW / 2, phY + phH - 12);
  ctx.textAlign = 'left';

  // QR under the portrait
  const qrSize = 108;
  drawQR(ctx, phX + (phW - qrSize) / 2, phY + phH + 26, qrSize, permalink, pal.pri);
  ctx.font = `9px ${FONT}`;
  ctx.fillStyle = withAlpha(pal.sec, 0.5);
  ctx.textAlign = 'center';
  ctx.fillText('SCAN TO VERIFY', phX + phW / 2, phY + phH + 26 + qrSize + 16);
  ctx.textAlign = 'left';

  // ── fields (right column) ──
  const fx = 262;
  const fw = CW - fx - 36;

  // big bearer name
  let nameSize = 44;
  ctx.font = `${nameSize}px ${FONT}`;
  while (ctx.measureText(name + '.agent').width > fw && nameSize > 18) {
    nameSize -= 2;
    ctx.font = `${nameSize}px ${FONT}`;
  }
  const nameY = 152;
  ctx.shadowColor = pal.glow;
  ctx.shadowBlur = 14;
  ctx.fillStyle = pal.sec;
  ctx.fillText(name, fx, nameY);
  const nW = ctx.measureText(name).width;
  ctx.fillStyle = pal.pri;
  ctx.fillText('.agent', fx + nW, nameY);
  ctx.shadowBlur = 0;

  // numbered fields (AAMVA-style indices)
  const label = (num, txt, x, y) => {
    ctx.font = `9px ${FONT}`;
    ctx.fillStyle = withAlpha(pal.acc, 0.75);
    ctx.fillText(num, x, y);
    const numW = ctx.measureText(num).width;
    ctx.fillStyle = withAlpha(pal.sec, 0.55);
    ctx.fillText('  ' + txt, x + numW, y);
  };
  const value = (txt, x, y, size = 17, color = pal.pri) => {
    ctx.font = `${size}px ${FONT}`;
    ctx.fillStyle = color;
    ctx.fillText(txt, x, y);
  };

  let fy = 196;
  label('4d', 'ID NO.', fx, fy);
  value(certId, fx, fy + 24, 24);
  fy += 64;

  const col2 = fx + fw * 0.52;
  label('1', 'CLASS', fx, fy);
  value(CLASS_BY_TYPE[accountType] || CLASS_BY_TYPE.individual, fx, fy + 21);
  label('9', 'TYPE', col2, fy);
  value(accountType.toUpperCase(), col2, fy + 21);
  fy += 58;

  label('4a', 'ISSUED', fx, fy);
  value(opts.issued || new Date().toISOString().slice(0, 7).replace('-', '.'), fx, fy + 21);
  label('4b', 'EXPIRES', col2, fy);
  value('NEVER', col2, fy + 21);
  fy += 58;

  label('12', 'RESTRICTIONS', fx, fy);
  value('NON-BINDING PRE-REG', fx, fy + 21, 15);
  label('9a', 'ENDORSEMENTS', col2, fy);
  value(opts.endorsements || 'NONE', col2, fy + 21, 15, withAlpha(pal.pri, 0.85));
  fy += 44;

  // microprint divider
  drawMicroprint(ctx, fx, fy + 8, fw, pal);

  // ── signature ──
  const sigY = fy + 64;
  drawSignature(ctx, fx, sigY, fw * 0.46, dna.borderSeed, pal.sec);
  ctx.fillStyle = withAlpha(pal.sec, 0.4);
  ctx.fillRect(fx, sigY + 30, fw * 0.5, 1);
  ctx.font = `8px ${FONT}`;
  ctx.fillStyle = withAlpha(pal.sec, 0.45);
  ctx.fillText('SIGNATURE OF BEARER', fx, sigY + 44);

  // seal overlapping the signature corner
  drawSeal(ctx, fx + fw - 78, sigY - 4, 72, pal, rarity.sym);

  // ── footer ──
  const ftY = CH - 52;
  ctx.fillStyle = withAlpha(pal.pri, 0.35);
  ctx.fillRect(36, ftY, CW - 72, 1);
  drawBarcode(ctx, 36, ftY + 12, 240, 24, certId, withAlpha(pal.pri, 0.8));
  ctx.font = `8px ${FONT}`;
  ctx.fillStyle = withAlpha(pal.sec, 0.45);
  ctx.fillText(certId, 36, ftY + 47);
  ctx.textAlign = 'center';
  ctx.fillStyle = withAlpha(pal.sec, 0.5);
  ctx.font = `9px ${FONT}`;
  ctx.fillText('NOT VALID FOR HUMAN IDENTIFICATION', CW / 2, ftY + 28);
  ctx.textAlign = 'right';
  ctx.fillStyle = withAlpha(pal.pri, 0.6);
  ctx.fillText('dmv.agentcommunity.org', CW - 36, ftY + 28);
  ctx.textAlign = 'left';

  // ── frame: outer border + corner brackets (brand continuity) ──
  ctx.strokeStyle = withAlpha(pal.pri, 0.3);
  ctx.lineWidth = 1;
  ctx.strokeRect(8, 8, CW - 16, CH - 16);
  ctx.strokeStyle = withAlpha(pal.pri, 0.8);
  ctx.lineWidth = 2;
  const B = 26;
  for (const [cx, cy, dx, dy] of [[8, 8, 1, 1], [CW - 8, 8, -1, 1], [8, CH - 8, 1, -1], [CW - 8, CH - 8, -1, -1]]) {
    ctx.beginPath();
    ctx.moveTo(cx + dx * B, cy);
    ctx.lineTo(cx, cy);
    ctx.lineTo(cx, cy + dy * B);
    ctx.stroke();
  }

  // scanlines + vignette (CRT brand continuity, lighter than production)
  ctx.fillStyle = 'rgba(0,0,0,0.05)';
  for (let sy = 0; sy < CH; sy += 3) ctx.fillRect(0, sy, CW, 1);
  const vig = ctx.createRadialGradient(CW / 2, CH / 2, CH * 0.45, CW / 2, CH / 2, CW * 0.75);
  vig.addColorStop(0, 'rgba(0,0,0,0)');
  vig.addColorStop(1, 'rgba(0,0,0,0.32)');
  ctx.fillStyle = vig;
  ctx.fillRect(0, 0, CW, CH);

  return { dna, pal, rarity, certId };
}

// ── Demo render ──
const samples = [
  { name: 'atlas', type: 'individual' },
  { name: 'nexus-7', type: 'agent' },
  { name: 'janebot', type: 'organization' },
  { name: 'ghost', type: 'agent' }, // hashes LEGENDARY
];

for (const { name, type } of samples) {
  const canvas = createCanvas(CW, CH);
  const { rarity, pal } = renderLicenseCard(canvas, name, { accountType: type });
  writeFileSync(`/tmp/license-${name}.png`, canvas.toBuffer('image/png'));
  console.log(`license-${name}.png  tier=${rarity.name}  palette=${pal.name}`);
}

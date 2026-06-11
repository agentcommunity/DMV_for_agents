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
  createCanvas, CardDNA, PALETTES, RARITIES, HOLOS, generateCertId, withAlpha, CW, CH,
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

// ── Machine signature: the bearer signs with its own bytes ──
//
// A logic-analyzer trace of the name's UTF-8 bits. Deterministic by
// construction — the signature IS the unique string, not a drawing of one.
// Byte boundaries get tick marks and the decoded character underneath.
function drawSignature(ctx, x, y, w, name, pal) {
  const bytes = Array.from(new TextEncoder().encode(name));
  const bits = [];
  for (const b of bytes) for (let i = 7; i >= 0; i--) bits.push((b >> i) & 1);

  const bitW = Math.max(3.5, Math.min(11, w / bits.length));
  const drawnBits = Math.min(bits.length, Math.floor(w / bitW));
  const truncated = drawnBits < bits.length;
  const hi = y - 16, lo = y + 4;

  ctx.save();
  // fade the tail out when a long name doesn't fit
  if (truncated) {
    const grad = ctx.createLinearGradient(x, 0, x + drawnBits * bitW, 0);
    grad.addColorStop(0, pal.sec);
    grad.addColorStop(0.8, pal.sec);
    grad.addColorStop(1, withAlpha(pal.sec, 0));
    ctx.strokeStyle = grad;
  } else {
    ctx.strokeStyle = pal.sec;
  }
  ctx.lineWidth = 1.6;
  ctx.lineJoin = 'miter';
  ctx.shadowColor = pal.glow;
  ctx.shadowBlur = 6;
  ctx.beginPath();
  let cx = x;
  ctx.moveTo(cx, bits[0] ? hi : lo);
  for (let i = 0; i < drawnBits; i++) {
    const rail = bits[i] ? hi : lo;
    if (i > 0 && bits[i] !== bits[i - 1]) ctx.lineTo(cx, rail); // edge
    ctx.lineTo(cx + bitW, rail);
    cx += bitW;
  }
  ctx.stroke();
  ctx.shadowBlur = 0;

  // byte-boundary ticks + decoded characters (the string, in the signal)
  const byteW = bitW * 8;
  const drawnBytes = Math.floor(drawnBits / 8);
  ctx.fillStyle = withAlpha(pal.acc, 0.55);
  for (let i = 0; i <= drawnBytes; i++) {
    ctx.fillRect(x + i * byteW, lo + 6, 1, 4);
  }
  if (byteW >= 26) {
    ctx.font = `9px ${FONT}`;
    ctx.textAlign = 'center';
    for (let i = 0; i < drawnBytes; i++) {
      ctx.fillStyle = withAlpha(pal.acc, 0.8);
      ctx.fillText(name[i] ?? '', x + i * byteW + byteW / 2, lo + 16);
    }
    ctx.textAlign = 'left';
  }
  ctx.restore();

  const hex = bytes.map((b) => b.toString(16).toUpperCase().padStart(2, '0'));
  return { hex, truncated };
}

// ── Epic borders: 4 DNA-keyed styles, multi-color, tier-scaled glow ──
const BORDER_NAMES = ['ENGRAVED', 'CIRCUIT', 'FILIGREE', 'GLITCH'];

function drawBorder(ctx, dna, pal, rarity) {
  const glow = 4 + rarity.intensity * 14;
  const inset = 8;
  const style = dna.border;
  ctx.save();

  if (style === 0) {
    // ENGRAVED — double frame, accent midpoint ticks, heavy corner brackets
    ctx.strokeStyle = withAlpha(pal.pri, 0.4);
    ctx.lineWidth = 1;
    ctx.strokeRect(inset, inset, CW - inset * 2, CH - inset * 2);
    ctx.strokeStyle = withAlpha(pal.pri, 0.18);
    ctx.strokeRect(inset + 5, inset + 5, CW - (inset + 5) * 2, CH - (inset + 5) * 2);
    ctx.strokeStyle = withAlpha(pal.acc, 0.8);
    ctx.lineWidth = 2;
    for (const [mx, my, horiz] of [[CW / 2, inset, 1], [CW / 2, CH - inset, 1], [inset, CH / 2, 0], [CW - inset, CH / 2, 0]]) {
      ctx.beginPath();
      if (horiz) { ctx.moveTo(mx - 14, my); ctx.lineTo(mx + 14, my); }
      else { ctx.moveTo(mx, my - 14); ctx.lineTo(mx, my + 14); }
      ctx.stroke();
    }
  } else if (style === 1) {
    // CIRCUIT — PCB traces running along the frame with pads and vias
    const rand = seededRand(dna.borderSeed);
    ctx.strokeStyle = withAlpha(pal.pri, 0.45);
    ctx.lineWidth = 1;
    ctx.strokeRect(inset, inset, CW - inset * 2, CH - inset * 2);
    const trace = (x1, y1, x2, y2, jog) => {
      ctx.strokeStyle = withAlpha(pal.pri, 0.7);
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
      if (Math.abs(x2 - x1) > Math.abs(y2 - y1)) { ctx.lineTo(mx, y1); ctx.lineTo(mx, y1 + jog); ctx.lineTo(mx + jog, y1 + jog); ctx.lineTo(x2, y1 + jog); }
      else { ctx.lineTo(x1, my); ctx.lineTo(x1 + jog, my); ctx.lineTo(x1 + jog, my + jog); ctx.lineTo(x1 + jog, y2); }
      ctx.stroke();
      // pad + via
      ctx.fillStyle = pal.acc;
      ctx.fillRect(x2 - 2.5, (Math.abs(x2 - x1) > Math.abs(y2 - y1) ? y1 + jog : y2) - 2.5, 5, 5);
      ctx.strokeStyle = withAlpha(pal.acc, 0.9);
      ctx.beginPath(); ctx.arc(x1, y1, 2.5, 0, Math.PI * 2); ctx.stroke();
    };
    for (let i = 0; i < 5; i++) {
      const t = 0.12 + rand() * 0.76;
      trace(CW * t, inset + 4, CW * (t + 0.04 + rand() * 0.05), inset + 4, 5 + rand() * 4 | 0);
      const b = 0.12 + rand() * 0.76;
      trace(CW * b, CH - inset - 4, CW * (b + 0.04 + rand() * 0.05), CH - inset - 4, -(5 + rand() * 4 | 0));
    }
    for (let i = 0; i < 3; i++) {
      const t = 0.18 + rand() * 0.6;
      trace(inset + 4, CH * t, inset + 4, CH * (t + 0.06 + rand() * 0.06), 5 + rand() * 4 | 0);
      trace(CW - inset - 4, CH * t, CW - inset - 4, CH * (t + 0.06 + rand() * 0.06), -(5 + rand() * 4 | 0));
    }
  } else if (style === 2) {
    // FILIGREE — double frame with nested corner arcs and edge diamonds
    ctx.strokeStyle = withAlpha(pal.pri, 0.45);
    ctx.lineWidth = 1;
    ctx.strokeRect(inset, inset, CW - inset * 2, CH - inset * 2);
    ctx.strokeStyle = withAlpha(pal.sec, 0.25);
    ctx.strokeRect(inset + 4, inset + 4, CW - (inset + 4) * 2, CH - (inset + 4) * 2);
    for (const [cx, cy, sx, sy] of [[inset, inset, 1, 1], [CW - inset, inset, -1, 1], [inset, CH - inset, 1, -1], [CW - inset, CH - inset, -1, -1]]) {
      for (let r = 14; r <= 38; r += 12) {
        ctx.strokeStyle = withAlpha(r === 26 ? pal.acc : pal.pri, 0.7 - r * 0.008);
        ctx.lineWidth = r === 26 ? 1.6 : 1;
        ctx.beginPath();
        ctx.arc(cx, cy, r, sx > 0 ? (sy > 0 ? 0 : -Math.PI / 2) : (sy > 0 ? Math.PI / 2 : Math.PI),
          sx > 0 ? (sy > 0 ? Math.PI / 2 : 0) : (sy > 0 ? Math.PI : -Math.PI / 2));
        ctx.stroke();
      }
      ctx.fillStyle = pal.acc;
      ctx.beginPath();
      ctx.arc(cx + sx * 46, cy + sy * 8, 2, 0, Math.PI * 2);
      ctx.arc(cx + sx * 8, cy + sy * 46, 2, 0, Math.PI * 2);
      ctx.fill();
    }
    for (const [mx, my] of [[CW / 2, inset], [CW / 2, CH - inset], [inset, CH / 2], [CW - inset, CH / 2]]) {
      ctx.fillStyle = withAlpha(pal.sec, 0.85);
      ctx.beginPath();
      ctx.moveTo(mx, my - 6); ctx.lineTo(mx + 5, my); ctx.lineTo(mx, my + 6); ctx.lineTo(mx - 5, my);
      ctx.closePath(); ctx.fill();
    }
  } else {
    // GLITCH — RGB-split frame with seeded dropouts and slice marks
    const rand = seededRand(dna.borderSeed);
    for (const [color, dx, alpha] of [[pal.acc2, -2, 0.5], [pal.acc, 2, 0.5], [pal.pri, 0, 0.9]]) {
      ctx.strokeStyle = withAlpha(color, alpha);
      ctx.lineWidth = dx === 0 ? 1.4 : 1;
      ctx.setLineDash([26 + rand() * 30, 4 + rand() * 10, 60 + rand() * 40, 6]);
      ctx.lineDashOffset = rand() * 80;
      ctx.strokeRect(inset + dx, inset, CW - inset * 2, CH - inset * 2);
    }
    ctx.setLineDash([]);
    for (let i = 0; i < 7; i++) {
      const edge = rand();
      const len = 10 + rand() * 26;
      ctx.fillStyle = withAlpha(rand() > 0.5 ? pal.acc : pal.acc2, 0.7);
      if (edge < 0.5) ctx.fillRect(20 + rand() * (CW - 60), (edge < 0.25 ? inset : CH - inset) - 1, len, 2.5);
      else ctx.fillRect((edge < 0.75 ? inset : CW - inset) - 1, 20 + rand() * (CH - 60), 2.5, len);
    }
  }

  // corner brackets — shared brand mark on every style, tier-scaled glow
  ctx.shadowColor = pal.glow;
  ctx.shadowBlur = glow;
  ctx.strokeStyle = withAlpha(pal.pri, 0.9);
  ctx.lineWidth = 2.5;
  const B = 28;
  for (const [cx, cy, dx, dy] of [[inset, inset, 1, 1], [CW - inset, inset, -1, 1], [inset, CH - inset, 1, -1], [CW - inset, CH - inset, -1, -1]]) {
    ctx.beginPath();
    ctx.moveTo(cx + dx * B, cy);
    ctx.lineTo(cx, cy);
    ctx.lineTo(cx, cy + dy * B);
    ctx.stroke();
  }
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
  // DNA readout — the card states its own traits
  ctx.font = `8px ${FONT}`;
  ctx.fillStyle = withAlpha(pal.acc, 0.6);
  ctx.fillText(
    `DNA ${pal.name.toUpperCase()} / ${BORDER_NAMES[dna.border]} / ${HOLOS[dna.holo].name.toUpperCase()} FINISH`,
    CW - 36, 76,
  );
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

  // ── signature: the bearer's own bytes as a logic trace ──
  const sigY = fy + 64;
  const sig = drawSignature(ctx, fx, sigY, fw * 0.52, name, pal);
  ctx.fillStyle = withAlpha(pal.sec, 0.4);
  ctx.fillRect(fx, sigY + 30, fw * 0.56, 1);
  ctx.font = `8px ${FONT}`;
  ctx.fillStyle = withAlpha(pal.sec, 0.45);
  const hexShown = sig.hex.slice(0, 10).join(' ') + (sig.hex.length > 10 ? ' …' : '');
  ctx.fillText(`SIGNATURE OF BEARER · UTF-8 0x${hexShown}`, fx, sigY + 44);

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

  // ── frame: DNA-keyed epic border ──
  drawBorder(ctx, dna, pal, rarity);

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

// make sure every border style appears in the demo set
const covered = new Set(samples.map(({ name }) => new CardDNA(name).border));
for (const candidate of ['oracle', 'cipher', 'vega', 'helix', 'lumen', 'drift', 'sol', 'echo', 'nova', 'pixel', 'quark', 'raven']) {
  if (covered.size === 4) break;
  const b = new CardDNA(candidate).border;
  if (!covered.has(b)) {
    covered.add(b);
    samples.push({ name: candidate, type: 'agent' });
  }
}

for (const { name, type } of samples) {
  const canvas = createCanvas(CW, CH);
  const { rarity, pal, dna } = renderLicenseCard(canvas, name, { accountType: type });
  writeFileSync(`/tmp/license-${name}.png`, canvas.toBuffer('image/png'));
  console.log(`license-${name}.png  tier=${rarity.name}  palette=${pal.name}  border=${BORDER_NAMES[dna.border]}`);
}

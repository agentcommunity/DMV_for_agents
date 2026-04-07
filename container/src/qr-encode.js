// Minimal QR Code encoder — byte mode, ECL L, versions 1-6
// Generates a boolean matrix suitable for Canvas2D rendering.
// No dependencies. ~250 lines.

// ═══════════════════════════════════════════════════════════════
//  VERSION TABLES (ECL L only — 7% error recovery)
// ═══════════════════════════════════════════════════════════════

// Total data codewords per version at ECL L
const DATA_CODEWORDS = [0, 19, 34, 55, 80, 108, 136];
// EC codewords per block at ECL L
const EC_CODEWORDS   = [0, 7,  10, 15, 20, 26,  18];
// Number of EC blocks at ECL L
const EC_BLOCKS      = [0, 1,  1,  1,  1,  1,   2];
// Module size per version: 17 + 4*v
const moduleCount = v => 17 + 4 * v;
// Alignment pattern centers (versions 2-6)
const ALIGN_CENTERS  = [0, [], [6,18], [6,22], [6,26], [6,30], [6,34]];

// ═══════════════════════════════════════════════════════════════
//  GF(2^8) ARITHMETIC for Reed-Solomon
// ═══════════════════════════════════════════════════════════════
const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x = (x << 1) ^ (x & 128 ? 0x11d : 0);
  }
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255];
}

function gfMul(a, b) {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[GF_LOG[a] + GF_LOG[b]];
}

function rsEncode(data, ecLen) {
  // Build generator polynomial
  let gen = [1];
  for (let i = 0; i < ecLen; i++) {
    const next = new Array(gen.length + 1).fill(0);
    for (let j = 0; j < gen.length; j++) {
      next[j] ^= gen[j];
      next[j + 1] ^= gfMul(gen[j], GF_EXP[i]);
    }
    gen = next;
  }
  const msg = new Uint8Array(data.length + ecLen);
  msg.set(data);
  for (let i = 0; i < data.length; i++) {
    const coef = msg[i];
    if (coef === 0) continue;
    for (let j = 0; j < gen.length; j++) {
      msg[i + j] ^= gfMul(gen[j], coef);
    }
  }
  return msg.slice(data.length);
}

// ═══════════════════════════════════════════════════════════════
//  DATA ENCODING (byte mode)
// ═══════════════════════════════════════════════════════════════

function encodeData(text, version) {
  const bytes = new TextEncoder().encode(text);
  const totalDC = DATA_CODEWORDS[version];
  const bits = [];
  const push = (val, len) => { for (let i = len - 1; i >= 0; i--) bits.push((val >> i) & 1); };

  // Mode indicator: byte = 0100
  push(0b0100, 4);
  // Character count (8 bits for v1-9)
  push(bytes.length, 8);
  // Data
  for (const b of bytes) push(b, 8);
  // Terminator (up to 4 zeros)
  const cap = totalDC * 8;
  for (let i = 0; i < 4 && bits.length < cap; i++) bits.push(0);
  // Pad to byte boundary
  while (bits.length % 8 !== 0) bits.push(0);
  // Pad codewords
  const pads = [0xEC, 0x11];
  let pi = 0;
  while (bits.length < cap) { push(pads[pi % 2], 8); pi++; }

  // Convert to bytes
  const codewords = new Uint8Array(totalDC);
  for (let i = 0; i < totalDC; i++) {
    let v = 0;
    for (let b = 0; b < 8; b++) v = (v << 1) | (bits[i * 8 + b] || 0);
    codewords[i] = v;
  }
  return codewords;
}

// ═══════════════════════════════════════════════════════════════
//  ERROR CORRECTION + INTERLEAVING
// ═══════════════════════════════════════════════════════════════

function addErrorCorrection(data, version) {
  const ecLen = EC_CODEWORDS[version];
  const numBlocks = EC_BLOCKS[version];
  const totalDC = DATA_CODEWORDS[version];
  const blockSize = Math.floor(totalDC / numBlocks);
  const remainder = totalDC % numBlocks;

  const dataBlocks = [];
  const ecBlocks = [];
  let offset = 0;
  for (let b = 0; b < numBlocks; b++) {
    const sz = blockSize + (b >= numBlocks - remainder ? 1 : 0);
    const block = data.slice(offset, offset + sz);
    dataBlocks.push(block);
    ecBlocks.push(rsEncode(block, ecLen));
    offset += sz;
  }

  // Interleave data codewords
  const result = [];
  const maxDLen = blockSize + (remainder > 0 ? 1 : 0);
  for (let i = 0; i < maxDLen; i++) {
    for (let b = 0; b < numBlocks; b++) {
      if (i < dataBlocks[b].length) result.push(dataBlocks[b][i]);
    }
  }
  // Interleave EC codewords
  for (let i = 0; i < ecLen; i++) {
    for (let b = 0; b < numBlocks; b++) {
      result.push(ecBlocks[b][i]);
    }
  }
  return result;
}

// ═══════════════════════════════════════════════════════════════
//  MODULE PLACEMENT
// ═══════════════════════════════════════════════════════════════

function createMatrix(version) {
  const n = moduleCount(version);
  // 0 = unset, 1 = black-function, 2 = white-function, 3 = black-data, 4 = white-data
  const grid = Array.from({ length: n }, () => new Uint8Array(n));

  // Finder patterns
  const finder = (r, c) => {
    for (let dr = -1; dr <= 7; dr++) {
      for (let dc = -1; dc <= 7; dc++) {
        const rr = r + dr, cc = c + dc;
        if (rr < 0 || rr >= n || cc < 0 || cc >= n) continue;
        const inOuter = dr === -1 || dr === 7 || dc === -1 || dc === 7;
        const inBorder = dr === 0 || dr === 6 || dc === 0 || dc === 6;
        const inInner = dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4;
        grid[rr][cc] = (inBorder || inInner) && !inOuter ? 1 : 2;
      }
    }
  };
  finder(0, 0); finder(0, n - 7); finder(n - 7, 0);

  // Timing patterns
  for (let i = 8; i < n - 8; i++) {
    grid[6][i] = grid[6][i] || (i % 2 === 0 ? 1 : 2);
    grid[i][6] = grid[i][6] || (i % 2 === 0 ? 1 : 2);
  }

  // Alignment patterns (v >= 2)
  const centers = ALIGN_CENTERS[version];
  if (centers.length) {
    for (const r of centers) {
      for (const c of centers) {
        if (grid[r][c] !== 0) continue; // skip if overlaps finder
        for (let dr = -2; dr <= 2; dr++) {
          for (let dc = -2; dc <= 2; dc++) {
            const isBlack = Math.abs(dr) === 2 || Math.abs(dc) === 2 || (dr === 0 && dc === 0);
            grid[r + dr][c + dc] = isBlack ? 1 : 2;
          }
        }
      }
    }
  }

  // Dark module
  grid[n - 8][8] = 1;

  // Reserve format info areas (will be written later)
  for (let i = 0; i < 8; i++) {
    if (grid[8][i] === 0) grid[8][i] = 2;
    if (grid[i][8] === 0) grid[i][8] = 2;
    if (grid[8][n - 1 - i] === 0) grid[8][n - 1 - i] = 2;
    if (grid[n - 1 - i][8] === 0) grid[n - 1 - i][8] = 2;
  }
  if (grid[8][8] === 0) grid[8][8] = 2;

  return grid;
}

function placeData(grid, bits, n) {
  let idx = 0;
  let up = true;
  for (let col = n - 1; col > 0; col -= 2) {
    if (col === 6) col = 5; // skip timing column
    const rows = up ? Array.from({ length: n }, (_, i) => n - 1 - i) : Array.from({ length: n }, (_, i) => i);
    for (const row of rows) {
      for (const dc of [0, -1]) {
        const c = col + dc;
        if (c < 0 || grid[row][c] !== 0) continue;
        grid[row][c] = idx < bits.length && bits[idx] ? 3 : 4;
        idx++;
      }
    }
    up = !up;
  }
}

// ═══════════════════════════════════════════════════════════════
//  MASKING
// ═══════════════════════════════════════════════════════════════

const MASK_FNS = [
  (r, c) => (r + c) % 2 === 0,
  (r, c) => r % 2 === 0,
  (r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2 + (r * c) % 3) === 0,
  (r, c) => ((r * c) % 2 + (r * c) % 3) % 2 === 0,
  (r, c) => ((r + c) % 2 + (r * c) % 3) % 2 === 0,
];

// Format info strings for ECL L (0b01) + mask 0-7
const FORMAT_BITS = [
  0x77C4, 0x72F3, 0x7DAA, 0x789D, 0x662F, 0x6318, 0x6C41, 0x6976,
];

function applyMask(grid, maskIdx, n) {
  const fn = MASK_FNS[maskIdx];
  const out = grid.map(r => r.slice());
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (out[r][c] >= 3 && fn(r, c)) {
        out[r][c] = out[r][c] === 3 ? 4 : 3;
      }
    }
  }
  // Write format info
  const fmt = FORMAT_BITS[maskIdx];
  const setBit = (r, c, bit) => { out[r][c] = bit ? 1 : 2; };
  for (let i = 0; i < 15; i++) {
    const bit = (fmt >> (14 - i)) & 1;
    // Around top-left finder
    if (i < 6) setBit(8, i, bit);
    else if (i === 6) setBit(8, 7, bit);
    else if (i === 7) setBit(8, 8, bit);
    else if (i === 8) setBit(7, 8, bit);
    else setBit(14 - i, 8, bit);
    // Split across right/bottom
    if (i < 8) setBit(n - 1 - i, 8, bit);
    else setBit(8, n - 8 + (i - 8), bit);
  }
  return out;
}

function penalty(grid, n) {
  let score = 0;
  const isBlack = (r, c) => grid[r][c] === 1 || grid[r][c] === 3;
  // Rule 1: consecutive same-color in rows/cols
  for (let r = 0; r < n; r++) {
    let run = 1;
    for (let c = 1; c < n; c++) {
      if (isBlack(r, c) === isBlack(r, c - 1)) { run++; }
      else { if (run >= 5) score += run - 2; run = 1; }
    }
    if (run >= 5) score += run - 2;
  }
  for (let c = 0; c < n; c++) {
    let run = 1;
    for (let r = 1; r < n; r++) {
      if (isBlack(r, c) === isBlack(r - 1, c)) { run++; }
      else { if (run >= 5) score += run - 2; run = 1; }
    }
    if (run >= 5) score += run - 2;
  }
  // Rule 4: proportion
  let black = 0;
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (isBlack(r, c)) black++;
  const pct = (black * 100) / (n * n);
  score += Math.abs(Math.floor(pct / 5) * 5 - 50) * 2;
  return score;
}

// ═══════════════════════════════════════════════════════════════
//  PUBLIC API
// ═══════════════════════════════════════════════════════════════

/**
 * Generate a QR code matrix for the given text.
 * Returns { matrix: boolean[][], size: number }
 * matrix[row][col] = true means dark module.
 */
export function generateQRMatrix(text) {
  const bytes = new TextEncoder().encode(text);
  // Pick smallest version that fits
  let version = 0;
  for (let v = 1; v <= 6; v++) {
    // Byte mode overhead: 4 (mode) + 8 (count) = 12 bits = 1.5 bytes
    if (bytes.length + 3 <= DATA_CODEWORDS[v]) { version = v; break; }
  }
  if (!version) version = 6; // clamp to max supported

  const n = moduleCount(version);
  const data = encodeData(text, version);
  const final = addErrorCorrection(data, version);

  // Convert to bit array
  const bits = [];
  for (const byte of final) {
    for (let b = 7; b >= 0; b--) bits.push((byte >> b) & 1);
  }

  const grid = createMatrix(version);
  placeData(grid, bits, n);

  // Try all 8 masks, pick lowest penalty
  let bestMask = 0, bestPenalty = Infinity;
  for (let m = 0; m < 8; m++) {
    const masked = applyMask(grid, m, n);
    const p = penalty(masked, n);
    if (p < bestPenalty) { bestPenalty = p; bestMask = m; }
  }

  const result = applyMask(grid, bestMask, n);

  // Convert to boolean matrix
  const matrix = [];
  for (let r = 0; r < n; r++) {
    matrix[r] = [];
    for (let c = 0; c < n; c++) {
      matrix[r][c] = result[r][c] === 1 || result[r][c] === 3;
    }
  }

  return { matrix, size: n };
}

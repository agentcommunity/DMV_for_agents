// Card renderer — Node.js port of js/card-draw.js, running inside the
// Cloudflare Container that backs /api/card and /api/og. Uses @napi-rs/canvas
// (Skia-based) for deterministic server-side drawing: same name → same card,
// no database needed.
//
// IMPORTANT: This must stay aligned with js/card-draw.js (browser version).
// Both use CARD_VERSION=3, landscape 880x630, identical CardDNA hashing.
// The QR encoder in this directory is drift-checked against js/qr-encode.js
// on every build (see scripts/build-cf.mjs).

import { createCanvas, GlobalFonts } from '@napi-rs/canvas';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { generateQRMatrix } from './qr-encode.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Register PPSupplyMono — the font is vendored into container/fonts/ by
// scripts/build-cf.mjs from the repo-root fonts/ directory.
try {
  const fontPath = path.join(__dirname, '..', 'fonts', 'PPSupplyMono-Regular.otf');
  GlobalFonts.registerFromPath(fontPath, 'PPSupplyMono');
} catch (e) {
  // Font may not be available — fall back to monospace
}

// ═══════════════════════════════════════════════════════════════
//  CONFIG — must match card-draw.js
// ═══════════════════════════════════════════════════════════════
const CARD_VERSION = 3;
const CW = 880, CH = 630;
const PAD = 20;

// ═══════════════════════════════════════════════════════════════
//  UTILITIES
// ═══════════════════════════════════════════════════════════════
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
  return () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
}

function hexToRgb(hex) {
  return [parseInt(hex.slice(1,3),16), parseInt(hex.slice(3,5),16), parseInt(hex.slice(5,7),16)];
}

function withAlpha(hex, a) {
  const [r,g,b] = hexToRgb(hex);
  return `rgba(${r},${g},${b},${a})`;
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x+r, y);
  ctx.arcTo(x+w, y, x+w, y+h, r);
  ctx.arcTo(x+w, y+h, x, y+h, r);
  ctx.arcTo(x, y+h, x, y, r);
  ctx.arcTo(x, y, x+w, y, r);
  ctx.closePath();
}

function generateCertId(name) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const rand = seededRand(fnv1a(name + ':cert'));
  const pick = () => chars[(rand() * chars.length) | 0];
  return `${pick()}${pick()}${pick()}${pick()}-${pick()}${pick()}${pick()}-${pick()}${pick()}${pick()}${pick()}`;
}

function mixHash(h, salt) {
  let m = h ^ salt;
  m = Math.imul(m ^ (m >>> 16), 0x45d9f3b);
  m = Math.imul(m ^ (m >>> 13), 0x45d9f3b);
  return (m ^ (m >>> 16)) >>> 0;
}

// ═══════════════════════════════════════════════════════════════
//  DRAWING HELPERS
// ═══════════════════════════════════════════════════════════════
function drawCorners(ctx, x, y, w, h, color, size) {
  const L = size || 25, T = 2;
  ctx.fillStyle = color;
  ctx.fillRect(x, y, L, T);           ctx.fillRect(x, y, T, L);
  ctx.fillRect(x+w-L, y, L, T);       ctx.fillRect(x+w-T, y, T, L);
  ctx.fillRect(x, y+h-T, L, T);       ctx.fillRect(x, y+h-L, T, L);
  ctx.fillRect(x+w-L, y+h-T, L, T);   ctx.fillRect(x+w-T, y+h-L, T, L);
}

function drawIdenticon(ctx, x, y, size, seed, color1, color2) {
  const rand = seededRand(seed);
  const grid = 9, cell = size / grid, half = Math.ceil(grid / 2);
  ctx.fillStyle = 'rgba(0,0,0,0.65)';
  ctx.fillRect(x, y, size, size);
  const cells = [];
  for (let gy = 0; gy < half; gy++) {
    cells[gy] = [];
    for (let gx = 0; gx < half; gx++) cells[gy][gx] = rand() > 0.42;
  }
  for (let gy = 0; gy < grid; gy++) {
    for (let gx = 0; gx < grid; gx++) {
      const sy = gy < half ? gy : grid-1-gy;
      const sx = gx < half ? gx : grid-1-gx;
      if (cells[sy] && cells[sy][sx]) {
        const t = gy / grid;
        const [r1,g1,b1] = hexToRgb(color1);
        const [r2,g2,b2] = hexToRgb(color2);
        const r = r1 + (r2-r1)*t, g = g1 + (g2-g1)*t, b = b1 + (b2-b1)*t;
        ctx.fillStyle = `rgba(${r|0},${g|0},${b|0},0.9)`;
        ctx.fillRect(x+gx*cell+1, y+gy*cell+1, cell-2, cell-2);
      }
    }
  }
}

function drawQR(ctx, x, y, size, url, color) {
  const { matrix, size: n } = generateQRMatrix(url);
  const c = size / n;
  ctx.fillStyle = 'rgba(0,0,0,0.6)';
  ctx.fillRect(x-2, y-2, size+4, size+4);
  ctx.fillStyle = color;
  for (let my = 0; my < n; my++) {
    for (let mx = 0; mx < n; mx++) {
      if (matrix[my][mx]) ctx.fillRect(x+mx*c, y+my*c, c, c);
    }
  }
}

// Code 128B barcode encoder
const CODE128B_PAT = '212222,222122,222221,121223,121322,131222,122213,122312,132212,221213,221312,231212,112232,122132,122231,113222,123122,123221,223211,221132,221231,213212,223112,312131,311222,321122,321221,312212,322112,322211,212123,212321,232121,111323,131123,131321,112313,132113,132311,211313,231113,231311,112133,112331,132131,113123,113321,133121,313121,211331,231131,213113,213311,213131,311123,311321,331121,312113,312311,332111,314111,221411,431111,111224,111422,121124,121421,141122,141221,112214,112412,122114,122411,142112,142211,241211,221114,413111,241112,134111,111242,121142,121241,114212,124112,124211,411212,421112,421211,212141,214121,412121,111143,111341,131141,114113,114311,411113,411311,113141,114131,311141,411131,211412,211214,211232'.split(',');
const CODE128_STOP = '2331112';

function encodeCode128B(text) {
  const bars = [CODE128B_PAT[104]]; // Start Code B
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

function drawGradientDivider(ctx, x, y, w, color1, color2) {
  const grad = ctx.createLinearGradient(x, 0, x + w, 0);
  grad.addColorStop(0, 'transparent');
  grad.addColorStop(0.15, withAlpha(color1, 0.6));
  grad.addColorStop(0.5, withAlpha(color2, 0.9));
  grad.addColorStop(0.85, withAlpha(color1, 0.6));
  grad.addColorStop(1, 'transparent');
  ctx.fillStyle = grad;
  ctx.fillRect(x, y, w, 1);
  const grad2 = ctx.createLinearGradient(x, 0, x + w, 0);
  grad2.addColorStop(0, 'transparent');
  grad2.addColorStop(0.3, withAlpha(color1, 0.2));
  grad2.addColorStop(0.7, withAlpha(color1, 0.2));
  grad2.addColorStop(1, 'transparent');
  ctx.fillStyle = grad2;
  ctx.fillRect(x, y + 3, w, 0.5);
}

// ═══════════════════════════════════════════════════════════════
//  PALETTES — must match card-draw.js
// ═══════════════════════════════════════════════════════════════
const PALETTES = [
  { name:'Terminal',  bg:'#060d08', bg2:'#040810', pri:'#33ff88', sec:'#66ffaa', dim:'#1a5a3a', acc:'#00eeff', acc2:'#ff44cc', glow:'#33ff88', bgL:'#112211' },
  { name:'Cyberpunk', bg:'#0d0610', bg2:'#06041a', pri:'#ff2d95', sec:'#ff77bb', dim:'#5a1a45', acc:'#00ffff', acc2:'#ffee00', glow:'#ff2d95', bgL:'#1c0e28' },
  { name:'Golden',    bg:'#0e0b04', bg2:'#0a0806', pri:'#ffd700', sec:'#ffec66', dim:'#5a4a1a', acc:'#ff8c00', acc2:'#e8e8e8', glow:'#ffd700', bgL:'#221c0a' },
  { name:'Ocean',     bg:'#040810', bg2:'#060414', pri:'#00bbff', sec:'#66ddff', dim:'#1a3a5a', acc:'#00ffcc', acc2:'#ff6644', glow:'#00bbff', bgL:'#0c1828' },
  { name:'Volcanic',  bg:'#0e0404', bg2:'#100806', pri:'#ff4422', sec:'#ff7755', dim:'#5a1a1a', acc:'#ffaa00', acc2:'#ff0066', glow:'#ff4422', bgL:'#221010' },
  { name:'Arctic',    bg:'#060810', bg2:'#080a18', pri:'#aaddff', sec:'#ddeeff', dim:'#2a3a55', acc:'#ffffff', acc2:'#cc88ff', glow:'#aaddff', bgL:'#121e30' },
  { name:'Void',      bg:'#08041a', bg2:'#0c0814', pri:'#aa44ff', sec:'#cc88ff', dim:'#3a1a55', acc:'#ff44ff', acc2:'#44aaff', glow:'#aa44ff', bgL:'#180e30' },
  { name:'Ember',     bg:'#0e0804', bg2:'#100604', pri:'#ff8833', sec:'#ffbb66', dim:'#5a3a1a', acc:'#ff4466', acc2:'#ffdd44', glow:'#ff8833', bgL:'#22180a' },
];

// ═══════════════════════════════════════════════════════════════
//  BORDERS — must match card-draw.js
// ═══════════════════════════════════════════════════════════════
const BORDERS = [
  {
    name: 'Clean',
    draw(ctx, x, y, w, h, pal) {
      ctx.strokeStyle = pal.acc; ctx.lineWidth = 2;
      ctx.strokeRect(x, y, w, h);
      ctx.strokeStyle = pal.dim; ctx.lineWidth = 1;
      ctx.strokeRect(x+6, y+6, w-12, h-12);
      drawCorners(ctx, x-4, y-4, w+8, h+8, pal.acc);
    }
  },
  {
    name: 'Circuit',
    draw(ctx, x, y, w, h, pal, seed) {
      const rand = seededRand(seed);
      ctx.strokeStyle = pal.acc; ctx.lineWidth = 1.5;
      ctx.strokeRect(x, y, w, h);
      ctx.strokeStyle = pal.dim; ctx.lineWidth = 0.5;
      ctx.strokeRect(x+4, y+4, w-8, h-8);
      for (let i = 0; i < 50; i++) {
        const side = (rand()*4)|0;
        let sx, sy, dx, dy;
        if (side===0)      { sx=x+rand()*w; sy=y;   dx=0;  dy=1;  }
        else if (side===1) { sx=x+w; sy=y+rand()*h;  dx=-1; dy=0;  }
        else if (side===2) { sx=x+rand()*w; sy=y+h;  dx=0;  dy=-1; }
        else               { sx=x;   sy=y+rand()*h;  dx=1;  dy=0;  }
        const len = 10 + rand()*35;
        const mx2 = sx+dx*len, my2 = sy+dy*len;
        ctx.strokeStyle = rand() > 0.3 ? pal.dim : pal.acc2;
        ctx.lineWidth = 0.8 + rand() * 0.5;
        ctx.globalAlpha = 0.4 + rand() * 0.4;
        ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(mx2, my2);
        const turn1 = (rand()>0.5?1:-1)*(8+rand()*20);
        let tx1, ty1;
        if (dx===0) { tx1=mx2+turn1; ty1=my2; } else { tx1=mx2; ty1=my2+turn1; }
        ctx.lineTo(tx1, ty1);
        if (rand() > 0.4) {
          const len2 = 5 + rand()*15;
          if (dx===0) ctx.lineTo(tx1, ty1+dy*len2);
          else ctx.lineTo(tx1+dx*len2, ty1);
        }
        ctx.stroke();
        ctx.globalAlpha = 1;
        ctx.fillStyle = rand() > 0.5 ? pal.acc : pal.acc2;
        ctx.globalAlpha = 0.5;
        ctx.beginPath(); ctx.arc(mx2, my2, 1.5 + rand(), 0, Math.PI*2); ctx.fill();
        ctx.globalAlpha = 1;
      }
    }
  },
  {
    name: 'Filigree',
    draw(ctx, x, y, w, h, pal) {
      ctx.strokeStyle = pal.dim; ctx.lineWidth = 0.5;
      ctx.strokeRect(x+2, y+2, w-4, h-4);
      ctx.strokeStyle = pal.dim; ctx.lineWidth = 1;
      ctx.strokeRect(x, y, w, h);
      const s = 45;
      ctx.lineWidth = 1.5;
      [[x,y,1,1],[x+w,y,-1,1],[x,y+h,1,-1],[x+w,y+h,-1,-1]].forEach(([cx,cy,ddx,ddy]) => {
        ctx.strokeStyle = pal.acc;
        ctx.beginPath();
        ctx.moveTo(cx, cy+ddy*s); ctx.lineTo(cx, cy); ctx.lineTo(cx+ddx*s, cy);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(cx+ddx*6, cy+ddy*s*0.75);
        ctx.quadraticCurveTo(cx+ddx*6, cy+ddy*6, cx+ddx*s*0.75, cy+ddy*6);
        ctx.stroke();
        ctx.strokeStyle = pal.acc2; ctx.lineWidth = 0.8;
        ctx.beginPath();
        ctx.moveTo(cx+ddx*12, cy+ddy*s*0.55);
        ctx.quadraticCurveTo(cx+ddx*12, cy+ddy*12, cx+ddx*s*0.55, cy+ddy*12);
        ctx.stroke();
        ctx.lineWidth = 1.5;
        // Diamond decoration at corner
        ctx.fillStyle = pal.acc2;
        const dx2 = cx+ddx*8, dy2 = cy+ddy*8;
        ctx.beginPath();
        ctx.moveTo(dx2, dy2-4); ctx.lineTo(dx2+4, dy2);
        ctx.lineTo(dx2, dy2+4); ctx.lineTo(dx2-4, dy2);
        ctx.closePath(); ctx.fill();
        // Midpoint accent dots
        ctx.fillStyle = pal.acc;
        ctx.globalAlpha = 0.5;
        ctx.beginPath(); ctx.arc(cx+ddx*s*0.5, cy+ddy*3, 1.5, 0, Math.PI*2); ctx.fill();
        ctx.beginPath(); ctx.arc(cx+ddx*3, cy+ddy*s*0.5, 1.5, 0, Math.PI*2); ctx.fill();
        ctx.globalAlpha = 1;
      });
      // Edge midpoint diamonds
      const dc = 8;
      [[x+w/2,y],[x+w/2,y+h],[x,y+h/2],[x+w,y+h/2]].forEach(([cx2,cy2], idx) => {
        ctx.strokeStyle = idx % 2 === 0 ? pal.acc : pal.acc2;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(cx2,cy2-dc); ctx.lineTo(cx2+dc,cy2);
        ctx.lineTo(cx2,cy2+dc); ctx.lineTo(cx2-dc,cy2);
        ctx.closePath(); ctx.stroke();
      });
    }
  },
  {
    name: 'Glitch',
    draw(ctx, x, y, w, h, pal, seed) {
      const rand = seededRand(seed);
      ctx.globalAlpha = 0.18;
      ctx.strokeStyle = '#ff0000'; ctx.lineWidth = 1.5;
      ctx.strokeRect(x+3, y+2, w, h);
      ctx.strokeStyle = '#0000ff'; ctx.lineWidth = 1.5;
      ctx.strokeRect(x-2, y-1, w, h);
      ctx.strokeStyle = '#00ff00'; ctx.lineWidth = 0.5;
      ctx.strokeRect(x+1, y-2, w, h);
      ctx.globalAlpha = 1;
      ctx.strokeStyle = pal.acc; ctx.lineWidth = 2;
      // Edge distortion
      const drawEdge = (x1,y1,x2,y2,horiz) => {
        ctx.beginPath(); ctx.moveTo(x1,y1);
        let c = horiz ? x1 : y1;
        const end = horiz ? x2 : y2;
        const dir = end > c ? 1 : -1;
        while ((dir>0 ? c<end : c>end)) {
          const seg = 12 + rand()*40;
          c = dir>0 ? Math.min(c+seg,end) : Math.max(c-seg,end);
          const shift = rand()>0.6 ? (rand()-0.5)*12 : 0;
          if (horiz) ctx.lineTo(c, y1+shift); else ctx.lineTo(x1+shift, c);
        }
        ctx.stroke();
      };
      drawEdge(x,y,x+w,y,true); drawEdge(x+w,y,x+w,y+h,false);
      drawEdge(x+w,y+h,x,y+h,true); drawEdge(x,y+h,x,y,false);
      // Glitch bar artifacts
      for (let i = 0; i < 12; i++) {
        const gy2 = y + rand()*h;
        const gw2 = 40+rand()*140;
        const gx2 = x + (rand()-0.3)*(w-gw2*0.5);
        const gh2 = 1 + rand()*3;
        ctx.fillStyle = rand() > 0.5 ? pal.acc : pal.acc2;
        ctx.globalAlpha = 0.03 + rand()*0.06;
        ctx.fillRect(gx2, gy2, gw2, gh2);
        ctx.globalAlpha = 1;
      }
    }
  },
];

// ═══════════════════════════════════════════════════════════════
//  PATTERNS — must match card-draw.js
// ═══════════════════════════════════════════════════════════════
const PATTERNS = [
  {
    name: 'Grid',
    draw(ctx, w, h, color, _seed, pal) {
      ctx.strokeStyle = color; ctx.lineWidth = 0.7;
      const sp = 28;
      for (let x2 = PAD; x2 < w-PAD; x2 += sp) {
        ctx.beginPath(); ctx.moveTo(x2, PAD); ctx.lineTo(x2, h-PAD); ctx.stroke();
      }
      for (let y2 = PAD; y2 < h-PAD; y2 += sp) {
        ctx.beginPath(); ctx.moveTo(PAD, y2); ctx.lineTo(w-PAD, y2); ctx.stroke();
      }
      if (pal) {
        ctx.fillStyle = pal.acc2; ctx.globalAlpha = 0.15;
        for (let x2 = PAD; x2 < w-PAD; x2 += sp*3) {
          for (let y2 = PAD; y2 < h-PAD; y2 += sp*3) {
            ctx.beginPath(); ctx.arc(x2, y2, 2, 0, Math.PI*2); ctx.fill();
          }
        }
        ctx.globalAlpha = 1;
      }
    }
  },
  {
    name: 'Hex',
    draw(ctx, w, h, color) {
      const sz = 20, hh = sz * Math.sqrt(3) / 2;
      ctx.strokeStyle = color; ctx.lineWidth = 0.5;
      for (let row = -1; row < h/hh+1; row++) {
        for (let col = -1; col < w/(sz*1.5)+1; col++) {
          const cx = col * sz * 1.5, cy = row * hh * 2 + (col%2 ? hh : 0);
          ctx.beginPath();
          for (let i = 0; i < 6; i++) {
            const a2 = Math.PI/180*(60*i-30);
            const px = cx + sz*0.85*Math.cos(a2), py = cy + sz*0.85*Math.sin(a2);
            if (i===0) ctx.moveTo(px,py); else ctx.lineTo(px,py);
          }
          ctx.closePath(); ctx.stroke();
        }
      }
    }
  },
  {
    name: 'Topo',
    draw(ctx, w, h, color, seed) {
      const rand = seededRand(seed);
      ctx.strokeStyle = color; ctx.lineWidth = 0.6;
      for (let ci = 0; ci < 5; ci++) {
        const ccx = w*(0.1+rand()*0.8), ccy = h*(0.1+rand()*0.8);
        const aspect = 0.4 + rand()*0.4;
        for (let r = 20; r < Math.max(w,h)*0.8; r += 14+rand()*12) {
          ctx.beginPath();
          for (let a2 = 0; a2 < Math.PI*2; a2 += 0.05) {
            const noise = Math.sin(a2*3+r*0.04)*r*0.12
                        + Math.sin(a2*5+ci)*r*0.05
                        + Math.sin(a2*11)*r*0.03;
            const px = ccx + Math.cos(a2)*(r+noise);
            const py = ccy + Math.sin(a2)*(r*aspect+noise*aspect);
            if (a2===0) ctx.moveTo(px,py); else ctx.lineTo(px,py);
          }
          ctx.closePath(); ctx.stroke();
        }
      }
    }
  },
  {
    name: 'Crosshatch',
    draw(ctx, w, h, color) {
      const sp = 14;
      ctx.strokeStyle = color; ctx.lineWidth = 0.4;
      for (let i = -h; i < w+h; i += sp) {
        ctx.beginPath(); ctx.moveTo(i,0); ctx.lineTo(i+h,h); ctx.stroke();
      }
      ctx.lineWidth = 0.3;
      for (let i = -h; i < w+h; i += sp) {
        ctx.beginPath(); ctx.moveTo(i,h); ctx.lineTo(i+h,0); ctx.stroke();
      }
    }
  },
];

// ═══════════════════════════════════════════════════════════════
//  HOLOS & RARITIES — must match card-draw.js
// ═══════════════════════════════════════════════════════════════
const HOLOS = [
  { name: 'Rainbow',   id: 'rainbow' },
  { name: 'Prism',     id: 'prism' },
  { name: 'Aurora',    id: 'aurora' },
  { name: 'Duo',       id: 'duochrome' },
];

const RARITIES = [
  { name:'STANDARD',  label:'STANDARD',             sym:'',   intensity:0.35, glow:4,  stars:40,  dropRate:50 },
  { name:'ENHANCED',  label:'\u25C7 ENHANCED \u25C7', sym:'\u25C7', intensity:0.55, glow:8,  stars:70,  dropRate:30 },
  { name:'RARE',      label:'\u2605 RARE \u2605',     sym:'\u2605', intensity:0.75, glow:14, stars:100, dropRate:15 },
  { name:'LEGENDARY', label:'\u2726 LEGENDARY \u2726',sym:'\u2726', intensity:0.95, glow:20, stars:150, dropRate:5  },
];

// ═══════════════════════════════════════════════════════════════
//  CARD DNA — must match card-draw.js (same hash salts)
// ═══════════════════════════════════════════════════════════════
class CardDNA {
  constructor(name) {
    this.name = name;
    const h = fnv1a(name);
    this.palette     = mixHash(h, 0x9e3779b9) % PALETTES.length;
    this.border      = mixHash(h, 0x517cc1b7) % BORDERS.length;
    this.pattern     = mixHash(h, 0x6c62272e) % PATTERNS.length;
    this.holo        = mixHash(h, 0x2e1b2138) % HOLOS.length;
    this.patternSeed = mixHash(h, 0x85ebca6b);
    this.borderSeed  = mixHash(h, 0xc2b2ae35);
    this.identiconSeed = h;
    this.starSeed    = mixHash(h, 0x3c6ef372);
    this.constellSeed = mixHash(h, 0x14057b7e);
    const roll = mixHash(h, 0x27d4eb2f) % 100;
    this.rarity = roll < 50 ? 0 : roll < 80 ? 1 : roll < 95 ? 2 : 3;
  }
}

// ═══════════════════════════════════════════════════════════════
//  LANDSCAPE CARD RENDERER (880 x 630)
//  Layout: Left column (identicon + QR) | divider | Right column
//  Must produce identical output to card-draw.js renderCard().
// ═══════════════════════════════════════════════════════════════

const INSET = PAD + 14;
const LEFT_W = 250;
const DIV_X = INSET + LEFT_W;
const RIGHT_X = DIV_X + 22;
const RIGHT_R = CW - INSET;
const RIGHT_W = RIGHT_R - RIGHT_X;
const FONT = "'PPSupplyMono', 'SF Mono', 'Fira Code', monospace";

function renderCard(canvas, name, dna, options) {
  const opts = options || {};
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, CW, CH);

  const pal = PALETTES[dna.palette];
  const rarity = RARITIES[dna.rarity];
  const border = BORDERS[dna.border];
  const pattern = PATTERNS[dna.pattern];
  const certId = opts.certId || generateCertId(name);
  const accountType = (opts.accountType || 'individual').toUpperCase();
  const baseUrl = opts.baseUrl || 'https://dmv.agentcommunity.org';
  const displayName = name + '.agent';

  // ── Background ──
  ctx.save();
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, CW, CH);
  roundRect(ctx, 0, 0, CW, CH, 14);
  ctx.clip();

  const bgGrad = ctx.createLinearGradient(0, 0, CW, CH);
  bgGrad.addColorStop(0, pal.bg);
  bgGrad.addColorStop(0.5, pal.bg2);
  bgGrad.addColorStop(1, pal.bg);
  ctx.fillStyle = bgGrad;
  ctx.fillRect(0, 0, CW, CH);

  // Ambient glows
  const g1 = ctx.createRadialGradient(CW * 0.3, CH * 0.3, 0, CW * 0.3, CH * 0.3, CW * 0.55);
  g1.addColorStop(0, withAlpha(pal.pri, 0.06));
  g1.addColorStop(1, 'transparent');
  ctx.fillStyle = g1;
  ctx.fillRect(0, 0, CW, CH);

  const g2 = ctx.createRadialGradient(CW * 0.7, CH * 0.7, 0, CW * 0.7, CH * 0.7, CW * 0.45);
  g2.addColorStop(0, withAlpha(pal.acc2, 0.04));
  g2.addColorStop(1, 'transparent');
  ctx.fillStyle = g2;
  ctx.fillRect(0, 0, CW, CH);

  // Star field
  const starCount = rarity.stars;
  const srand = seededRand(dna.starSeed);
  for (let i = 0; i < starCount; i++) {
    const sx = srand() * CW, sy = srand() * CH;
    const sz = 0.3 + srand() * 1.5;
    ctx.fillStyle = srand() > 0.5 ? pal.pri : pal.acc2;
    ctx.globalAlpha = 0.08 + srand() * 0.35;
    ctx.beginPath(); ctx.arc(sx, sy, sz, 0, Math.PI * 2); ctx.fill();
  }
  ctx.globalAlpha = 1;

  // Pattern overlay
  ctx.globalAlpha = 0.55;
  pattern.draw(ctx, CW, CH, withAlpha(pal.pri, 0.3), dna.patternSeed, pal);
  ctx.globalAlpha = 1;

  // Security strip
  ctx.save();
  ctx.translate(CW * 0.6, 0);
  ctx.rotate(Math.PI / 5);
  const stripGrad = ctx.createLinearGradient(0, -30, 0, 30);
  stripGrad.addColorStop(0, withAlpha(pal.pri, 0.03));
  stripGrad.addColorStop(0.3, withAlpha(pal.acc, 0.06));
  stripGrad.addColorStop(0.7, withAlpha(pal.acc2, 0.04));
  stripGrad.addColorStop(1, withAlpha(pal.pri, 0.05));
  ctx.fillStyle = stripGrad;
  ctx.fillRect(-CW, -14, CW * 3, 28);
  ctx.restore();

  // Border
  border.draw(ctx, PAD, PAD, CW - PAD * 2, CH - PAD * 2, pal, dna.borderSeed);
  ctx.globalAlpha = 1;

  // Vertical divider
  const dvGrad = ctx.createLinearGradient(0, PAD + 40, 0, CH - PAD - 40);
  dvGrad.addColorStop(0, 'transparent');
  dvGrad.addColorStop(0.2, withAlpha(pal.pri, 0.15));
  dvGrad.addColorStop(0.8, withAlpha(pal.pri, 0.15));
  dvGrad.addColorStop(1, 'transparent');
  ctx.fillStyle = dvGrad;
  ctx.fillRect(DIV_X, PAD + 40, 1, CH - PAD * 2 - 80);

  // ═══ LAYOUT CONSTANTS ═══
  const topY = INSET + 6;
  const headerY = topY + 18;
  const hdDivY = headerY + 12;
  const nameY = hdDivY + 72;
  const certLabelY = nameY + 96;
  const certValY = certLabelY + 30;
  const barcodeY = certValY + 14;
  const divY = barcodeY + 30;
  const row1Y = divY + 26;
  const row2Y = row1Y + 62;
  const footDivY = CH - INSET - 42;
  const footY = CH - INSET - 12;
  const colW = RIGHT_W / 3;

  // ═══ LEFT COLUMN ═══

  // Identicon
  const iconSize = 190;
  const iconX = INSET + (LEFT_W - iconSize) / 2;
  const iconY = 60;

  // Constellation
  const cr = seededRand(dna.constellSeed);
  const pts = [];
  for (let i = 0; i < 7 + (cr() * 6 | 0); i++)
    pts.push({ x: iconX - 20 + cr() * (iconSize + 40), y: iconY - 20 + cr() * (iconSize + 40) });
  ctx.strokeStyle = pal.pri; ctx.lineWidth = 0.6; ctx.globalAlpha = 0.12;
  for (let i = 0; i < pts.length; i++)
    for (let j = i + 1; j < pts.length; j++) {
      const dx = pts[i].x - pts[j].x, dy = pts[i].y - pts[j].y;
      if (Math.sqrt(dx*dx + dy*dy) < iconSize * 0.5) {
        ctx.beginPath(); ctx.moveTo(pts[i].x, pts[i].y); ctx.lineTo(pts[j].x, pts[j].y); ctx.stroke();
      }
    }
  ctx.fillStyle = pal.pri; ctx.globalAlpha = 0.5;
  for (const p of pts) { ctx.beginPath(); ctx.arc(p.x, p.y, 1.5, 0, Math.PI * 2); ctx.fill(); }
  ctx.globalAlpha = 1;

  // Identicon glow + frame + grid
  const ig = ctx.createRadialGradient(iconX + iconSize/2, iconY + iconSize/2, iconSize*0.2, iconX + iconSize/2, iconY + iconSize/2, iconSize*0.9);
  ig.addColorStop(0, withAlpha(pal.pri, 0.08 + rarity.intensity * 0.04));
  ig.addColorStop(1, 'transparent');
  ctx.fillStyle = ig;
  ctx.fillRect(iconX - 40, iconY - 40, iconSize + 80, iconSize + 80);
  ctx.strokeStyle = withAlpha(pal.pri, 0.3); ctx.lineWidth = 1;
  roundRect(ctx, iconX - 6, iconY - 6, iconSize + 12, iconSize + 12, 4); ctx.stroke();
  drawIdenticon(ctx, iconX, iconY, iconSize, dna.identiconSeed, pal.pri, pal.acc);

  // QR — scannable permalink URL
  const qrSize = 120;
  const qrX = INSET + 6;
  const qrY = footDivY - qrSize - 14;
  const qrUrl = `${baseUrl}/c/${encodeURIComponent(certId)}/${encodeURIComponent(name)}`;
  drawQR(ctx, qrX, qrY, qrSize, qrUrl, '#ffffff');

  ctx.font = `8px ${FONT}`;
  ctx.fillStyle = withAlpha('#ffffff', 0.35);
  ctx.textAlign = 'left';
  ctx.fillText('SCAN', qrX, qrY + qrSize + 10);

  // ═══ RIGHT COLUMN ═══

  // Chip
  const chipX = RIGHT_X, chipW = 44, chipH = 32;
  const chipGrad = ctx.createLinearGradient(chipX, topY, chipX + chipW, topY + chipH);
  chipGrad.addColorStop(0, withAlpha(pal.pri, 0.2));
  chipGrad.addColorStop(1, withAlpha(pal.acc, 0.1));
  roundRect(ctx, chipX, topY, chipW, chipH, 4); ctx.fillStyle = chipGrad; ctx.fill();
  ctx.strokeStyle = withAlpha(pal.pri, 0.4); ctx.lineWidth = 0.8;
  roundRect(ctx, chipX, topY, chipW, chipH, 4); ctx.stroke();
  const cmx = chipX + chipW/2, cmy = topY + chipH/2;
  ctx.strokeStyle = withAlpha(pal.pri, 0.2); ctx.lineWidth = 0.5;
  ctx.beginPath(); ctx.moveTo(chipX + 4, cmy); ctx.lineTo(chipX + chipW - 4, cmy); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(cmx, topY + 4); ctx.lineTo(cmx, topY + chipH - 4); ctx.stroke();

  // Header
  ctx.font = `16px ${FONT}`;
  ctx.fillStyle = withAlpha('#ffffff', 0.75);
  ctx.textAlign = 'left';
  ctx.fillText('DEPT. OF MACHINE VERIFICATION', chipX + chipW + 14, headerY);

  drawGradientDivider(ctx, RIGHT_X, hdDivY, RIGHT_W, pal.pri, pal.acc);

  // Rarity badge
  if (dna.rarity >= 1) {
    ctx.font = `bold 13px ${FONT}`;
    const badge = rarity.label;
    const bw = ctx.measureText(badge).width + 20;
    const bx = RIGHT_R - bw, by = topY;
    roundRect(ctx, bx, by, bw, 26, 13);
    ctx.fillStyle = withAlpha(pal.pri, 0.15); ctx.fill();
    ctx.strokeStyle = withAlpha(pal.pri, 0.4); ctx.lineWidth = 0.8;
    roundRect(ctx, bx, by, bw, 26, 13); ctx.stroke();
    ctx.fillStyle = '#ffffff'; ctx.textAlign = 'center';
    ctx.fillText(badge, bx + bw / 2, by + 17);
  }

  // Agent name
  ctx.textAlign = 'left';
  ctx.font = `bold 58px ${FONT}`;
  if (ctx.measureText(displayName).width > RIGHT_W) ctx.font = `bold 48px ${FONT}`;
  if (ctx.measureText(displayName).width > RIGHT_W) ctx.font = `bold 38px ${FONT}`;
  const nameGrad = ctx.createLinearGradient(RIGHT_X, nameY - 40, RIGHT_X + RIGHT_W * 0.8, nameY);
  nameGrad.addColorStop(0, '#ffffff');
  nameGrad.addColorStop(0.6, pal.sec);
  nameGrad.addColorStop(1, pal.pri);
  ctx.fillStyle = nameGrad;
  ctx.shadowColor = withAlpha(pal.pri, 0.4);
  ctx.shadowBlur = 3;
  ctx.fillText(displayName, RIGHT_X, nameY);
  ctx.shadowBlur = 0; ctx.shadowColor = 'transparent';

  // Cert ID
  ctx.font = `13px ${FONT}`;
  ctx.fillStyle = withAlpha('#ffffff', 0.5);
  ctx.fillText('CERTIFICATE ID', RIGHT_X, certLabelY);
  ctx.font = `bold 28px ${FONT}`;
  ctx.fillStyle = '#ffffff';
  ctx.fillText(certId, RIGHT_X, certValY);

  // Barcode
  drawBarcode(ctx, RIGHT_X, barcodeY, Math.min(280, RIGHT_W * 0.55), 20, certId, '#ffffff');

  // Divider
  ctx.fillStyle = withAlpha(pal.pri, 0.12);
  ctx.fillRect(RIGHT_X, divY, RIGHT_W, 0.5);

  // Data rows
  const drawField = (label, value, x, y) => {
    ctx.font = `13px ${FONT}`; ctx.fillStyle = withAlpha('#ffffff', 0.45);
    ctx.textAlign = 'left'; ctx.fillText(label, x, y);
    ctx.font = `bold 22px ${FONT}`; ctx.fillStyle = '#ffffff';
    ctx.fillText(value, x, y + 24);
  };

  drawField('TYPE', accountType, RIGHT_X, row1Y);
  drawField('STATUS', '\u25CF  PRE-REG', RIGHT_X + colW, row1Y);
  drawField('PROTOCOL', 'AID/1.0', RIGHT_X + colW * 2, row1Y);

  ctx.fillStyle = pal.pri;
  ctx.beginPath(); ctx.arc(RIGHT_X + colW + 1, row1Y + 22 - 6, 3.5, 0, Math.PI * 2); ctx.fill();

  const now = new Date();
  const issued = `${now.getFullYear()}.${String(now.getMonth() + 1).padStart(2, '0')}`;
  drawField('ISSUED', issued, RIGHT_X, row2Y);
  drawField('EXPIRES', 'NEVER', RIGHT_X + colW, row2Y);
  drawField('REGISTRY', '.agent', RIGHT_X + colW * 2, row2Y);

  // Rarity seal
  if (dna.rarity >= 2) {
    const sealX = RIGHT_R - 44, sealY = row2Y + 46;
    const sealR = 34;
    ctx.strokeStyle = withAlpha(pal.pri, 0.35); ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(sealX, sealY, sealR, 0, Math.PI * 2); ctx.stroke();
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(sealX, sealY, sealR - 7, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath(); ctx.arc(sealX, sealY, sealR - 14, 0, Math.PI * 2); ctx.stroke();
    ctx.font = `bold 10px ${FONT}`; ctx.fillStyle = pal.pri;
    ctx.textAlign = 'center'; ctx.fillText(rarity.name, sealX, sealY + 4);
  }

  // Non-binding disclaimer — short + legible so the holo overlay doesn't bury it.
  ctx.font = `13px ${FONT}`;
  ctx.fillStyle = withAlpha('#ffffff', 0.65);
  ctx.textAlign = 'left';
  ctx.fillText('Non-Binding Pre-Registration', RIGHT_X, footDivY - 13);

  // Footer divider
  drawGradientDivider(ctx, INSET, footDivY, CW - INSET * 2, pal.pri, pal.acc);

  // Bottom barcode
  drawBarcode(ctx, qrX, footDivY + 8, LEFT_W - 12, 16, name + '.agent', withAlpha('#ffffff', 0.8));

  // Footer URL
  ctx.font = `bold 14px ${FONT}`; ctx.fillStyle = withAlpha('#ffffff', 0.55);
  ctx.textAlign = 'right'; ctx.fillText('dmv.agentcommunity.org', RIGHT_R, footY);

  // Microtext
  ctx.font = '6px monospace'; ctx.fillStyle = pal.dim; ctx.globalAlpha = 0.08;
  ctx.textAlign = 'left';
  const micro = `NON-BINDING PRE-REGISTRATION \u00B7 ${name.toUpperCase()}.AGENT \u00B7 CERTIFICATE ${certId} \u00B7 `;
  const mtw = ctx.measureText(micro).width;
  let mx = INSET;
  while (mx < CW - INSET) { ctx.fillText(micro, mx, footY + 12); mx += mtw; }
  ctx.globalAlpha = 1;

  // Vertical edge text
  ctx.save();
  ctx.translate(CW - PAD - 6, CH / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.font = `bold 11px ${FONT}`;
  ctx.fillStyle = withAlpha(pal.pri, 0.5);
  ctx.textAlign = 'center';
  ctx.fillText('CERTIFICATE  OF  PRE-REGISTRATION', 0, 0);
  ctx.restore();

  // Scanlines
  ctx.fillStyle = 'rgba(0,0,0,0.06)';
  for (let sy = 0; sy < CH; sy += 3) ctx.fillRect(0, sy, CW, 1);

  // Vignette
  const vig = ctx.createRadialGradient(CW/2, CH/2, CW * 0.25, CW/2, CH/2, CW * 0.65);
  vig.addColorStop(0, 'transparent');
  vig.addColorStop(1, 'rgba(0,0,0,0.35)');
  ctx.fillStyle = vig;
  ctx.fillRect(0, 0, CW, CH);

  ctx.restore();
  return { certId, pal, rarity, dna };
}

export {
  createCanvas,
  withAlpha,
  roundRect,
  CardDNA,
  renderCard,
  generateCertId,
  PALETTES,
  RARITIES,
  HOLOS,
  CW,
  CH,
  CARD_VERSION,
};

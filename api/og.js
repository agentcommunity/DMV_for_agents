// Vercel Edge Function — Dynamic OG image generator
// Renders a branded 1200x630 PNG for each agent card.
//
// Usage:
//   /api/og?name=my-assistant   → per-card OG image (name-based, matches card)
//   /api/og                      → default DMV branding
//
// Rarity/palette computed identically to card-draw.js CardDNA.

import { ImageResponse } from '@vercel/og';

export const config = { runtime: 'edge' };

// --- Hashing (same as card-draw.js) ---

function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function mixHash(h, salt) {
  let m = h ^ salt;
  m = Math.imul(m ^ (m >>> 16), 0x45d9f3b);
  m = Math.imul(m ^ (m >>> 13), 0x45d9f3b);
  return (m ^ (m >>> 16)) >>> 0;
}

function generateCertId(name) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const rand = seededRand(fnv1a(name + ':cert'));
  const pick = () => chars[(rand() * chars.length) | 0];
  return `${pick()}${pick()}${pick()}${pick()}-${pick()}${pick()}${pick()}-${pick()}${pick()}${pick()}${pick()}`;
}

function seededRand(seed) {
  let s = seed;
  return () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
}

// --- CardDNA (same hash salts as card-draw.js) ---

const PALETTES = [
  { name:'Terminal',  pri:'#33ff88', acc:'#00eeff', glow:'#33ff88' },
  { name:'Cyberpunk', pri:'#ff2d95', acc:'#00ffff', glow:'#ff2d95' },
  { name:'Golden',    pri:'#ffd700', acc:'#ff8c00', glow:'#ffd700' },
  { name:'Ocean',     pri:'#00bbff', acc:'#00ffcc', glow:'#00bbff' },
  { name:'Volcanic',  pri:'#ff4422', acc:'#ffaa00', glow:'#ff4422' },
  { name:'Arctic',    pri:'#aaddff', acc:'#ffffff', glow:'#aaddff' },
  { name:'Void',      pri:'#aa44ff', acc:'#ff44ff', glow:'#aa44ff' },
  { name:'Ember',     pri:'#ff8833', acc:'#ff4466', glow:'#ff8833' },
];

const RARITIES = [
  { name: 'STANDARD',  dropRate: 50 },
  { name: 'ENHANCED',  dropRate: 30, sym: '\u25C7' },
  { name: 'RARE',      dropRate: 15, sym: '\u2605' },
  { name: 'LEGENDARY', dropRate: 5,  sym: '\u2726' },
];

const HOLOS = ['Rainbow', 'Prism', 'Aurora', 'Duochrome'];

function getCardDNA(name) {
  const h = fnv1a(name);
  const palette = mixHash(h, 0x9e3779b9) % PALETTES.length;
  const holo = mixHash(h, 0x2e1b2138) % HOLOS.length;
  const roll = mixHash(h, 0x27d4eb2f) % 100;
  const rarity = roll < 50 ? 0 : roll < 80 ? 1 : roll < 95 ? 2 : 3;
  return { palette, holo, rarity };
}

// --- Handler ---

export default function handler(req) {
  const { searchParams } = new URL(req.url);
  const agentName = searchParams.get('name') || '';
  // Support legacy ?id= param, but name is primary
  const certIdParam = searchParams.get('id') || '';

  const cacheHeaders = {
    'Cache-Control': 'public, max-age=86400, s-maxage=604800',
  };

  // Default (no params) — generic DMV branding
  if (!agentName && !certIdParam) {
    return new ImageResponse(
      defaultCard(),
      { width: 1200, height: 630, headers: cacheHeaders }
    );
  }

  // Compute card DNA from name (same as browser)
  const name = agentName || 'unknown';
  const dna = getCardDNA(name);
  const pal = PALETTES[dna.palette];
  const rarity = RARITIES[dna.rarity];
  const holoType = HOLOS[dna.holo];
  const certId = certIdParam || generateCertId(name);
  const displayName = `${name}.agent`;

  return new ImageResponse(
    agentCard(displayName, certId, pal, rarity, holoType),
    { width: 1200, height: 630, headers: cacheHeaders }
  );
}

// --- Card layouts (React-element-like objects for Satori) ---

function agentCard(displayName, certId, pal, rarity, holoType) {
  return {
    type: 'div',
    props: {
      style: {
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'center',
        alignItems: 'center',
        background: `linear-gradient(135deg, #0a0d0a 0%, #111614 50%, #0a0d0a 100%)`,
        fontFamily: 'monospace',
        position: 'relative',
        overflow: 'hidden',
      },
      children: [
        // Subtle grid pattern overlay
        {
          type: 'div',
          props: {
            style: {
              position: 'absolute',
              top: 0, left: 0, right: 0, bottom: 0,
              backgroundImage: `linear-gradient(${pal.pri}08 1px, transparent 1px), linear-gradient(90deg, ${pal.pri}08 1px, transparent 1px)`,
              backgroundSize: '40px 40px',
            },
          },
        },
        // Left accent bar (palette primary color)
        {
          type: 'div',
          props: {
            style: {
              position: 'absolute',
              left: 0, top: 0, bottom: 0,
              width: '6px',
              background: pal.pri,
            },
          },
        },
        // Rarity glow (top right)
        {
          type: 'div',
          props: {
            style: {
              position: 'absolute',
              top: '-100px',
              right: '-100px',
              width: '400px',
              height: '400px',
              borderRadius: '50%',
              background: `radial-gradient(circle, ${pal.pri}15 0%, transparent 70%)`,
            },
          },
        },
        // Agent name
        {
          type: 'div',
          props: {
            style: {
              display: 'flex',
              fontSize: '72px',
              fontWeight: 'bold',
              color: pal.pri,
              letterSpacing: '-2px',
              marginBottom: '16px',
            },
            children: displayName,
          },
        },
        // Certificate ID
        {
          type: 'div',
          props: {
            style: {
              display: 'flex',
              fontSize: '32px',
              color: '#888888',
              letterSpacing: '2px',
              marginBottom: '24px',
            },
            children: certId,
          },
        },
        // Rarity + Holo pills
        {
          type: 'div',
          props: {
            style: {
              display: 'flex',
              gap: '12px',
            },
            children: [
              // Rarity pill
              {
                type: 'div',
                props: {
                  style: {
                    display: 'flex',
                    padding: '8px 24px',
                    borderRadius: '6px',
                    backgroundColor: `${pal.pri}20`,
                    border: `1px solid ${pal.pri}40`,
                    fontSize: '18px',
                    color: pal.pri,
                    letterSpacing: '3px',
                  },
                  children: rarity.sym ? `${rarity.sym} ${rarity.name}` : rarity.name,
                },
              },
              // Holo type pill
              {
                type: 'div',
                props: {
                  style: {
                    display: 'flex',
                    padding: '8px 24px',
                    borderRadius: '6px',
                    backgroundColor: `${pal.acc}15`,
                    border: `1px solid ${pal.acc}30`,
                    fontSize: '18px',
                    color: pal.acc,
                    letterSpacing: '2px',
                  },
                  children: holoType.toUpperCase(),
                },
              },
            ],
          },
        },
        // Bottom branding
        {
          type: 'div',
          props: {
            style: {
              position: 'absolute',
              bottom: '32px',
              display: 'flex',
              alignItems: 'center',
              gap: '16px',
              fontSize: '16px',
              color: '#555555',
            },
            children: [
              {
                type: 'span',
                props: {
                  style: { color: pal.pri, fontSize: '18px' },
                  children: 'DMV',
                },
              },
              {
                type: 'span',
                props: {
                  children: 'Department of Machine Verification',
                },
              },
              {
                type: 'span',
                props: {
                  style: { color: '#333333' },
                  children: '|',
                },
              },
              {
                type: 'span',
                props: {
                  children: 'dmv.agentcommunity.org',
                },
              },
            ],
          },
        },
      ],
    },
  };
}

function defaultCard() {
  return {
    type: 'div',
    props: {
      style: {
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'center',
        alignItems: 'center',
        background: 'linear-gradient(135deg, #0a0d0a 0%, #111614 50%, #0a0d0a 100%)',
        fontFamily: 'monospace',
        position: 'relative',
        overflow: 'hidden',
      },
      children: [
        // Grid overlay
        {
          type: 'div',
          props: {
            style: {
              position: 'absolute',
              top: 0, left: 0, right: 0, bottom: 0,
              backgroundImage: 'linear-gradient(rgba(51,255,136,0.03) 1px, transparent 1px), linear-gradient(90deg, rgba(51,255,136,0.03) 1px, transparent 1px)',
              backgroundSize: '40px 40px',
            },
          },
        },
        // DMV title
        {
          type: 'div',
          props: {
            style: {
              display: 'flex',
              fontSize: '80px',
              fontWeight: 'bold',
              color: '#33ff88',
              letterSpacing: '8px',
              marginBottom: '16px',
            },
            children: 'DMV',
          },
        },
        // Subtitle
        {
          type: 'div',
          props: {
            style: {
              display: 'flex',
              fontSize: '28px',
              color: '#888888',
              letterSpacing: '2px',
              marginBottom: '40px',
            },
            children: 'Department of Machine Verification',
          },
        },
        // CTA
        {
          type: 'div',
          props: {
            style: {
              display: 'flex',
              padding: '12px 32px',
              borderRadius: '6px',
              border: '1px solid #33ff8840',
              fontSize: '22px',
              color: '#33ff88',
            },
            children: 'Pre-register your .agent identity',
          },
        },
        // Bottom branding
        {
          type: 'div',
          props: {
            style: {
              position: 'absolute',
              bottom: '32px',
              display: 'flex',
              fontSize: '16px',
              color: '#555555',
            },
            children: 'dmv.agentcommunity.org',
          },
        },
      ],
    },
  };
}

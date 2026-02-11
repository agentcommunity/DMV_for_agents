// Vercel Edge Function — Dynamic OG image generator
// Renders a branded 1200x630 PNG for each agent card.
//
// Usage:
//   /api/og?id=MESA-DD6-660J&name=my-assistant   → per-card OG image
//   /api/og                                        → default DMV branding

import { ImageResponse } from '@vercel/og';

export const config = { runtime: 'edge' };

// --- Rarity (same logic as HoloCard.js) ---

function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

const RARITIES = [
  { name: 'STANDARD',  pct: 60,  accent: '#33ff88' },
  { name: 'ENHANCED',  pct: 85,  accent: '#33ddff' },
  { name: 'RARE',      pct: 95,  accent: '#ffaa33' },
  { name: 'LEGENDARY', pct: 100, accent: '#ff44ff' },
];

function getRarity(certId) {
  const roll = fnv1a(certId || 'unknown') % 100;
  for (const r of RARITIES) {
    if (roll < r.pct) return r;
  }
  return RARITIES[0];
}

// --- Handler ---

export default function handler(req) {
  const { searchParams } = new URL(req.url);
  const certId = searchParams.get('id') || '';
  const agentName = searchParams.get('name') || '';

  const cacheHeaders = {
    'Cache-Control': 'public, max-age=86400, s-maxage=604800',
  };

  // Default (no params) — generic DMV branding
  if (!certId) {
    return new ImageResponse(
      defaultCard(),
      { width: 1200, height: 630, headers: cacheHeaders }
    );
  }

  const rarity = getRarity(certId);
  const displayName = agentName ? `${agentName}.agent` : 'unknown.agent';

  return new ImageResponse(
    agentCard(displayName, certId, rarity),
    { width: 1200, height: 630, headers: cacheHeaders }
  );
}

// --- Card layouts (React-element-like objects for Satori) ---

function agentCard(displayName, certId, rarity) {
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
        // Subtle grid pattern overlay
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
        // Left accent bar
        {
          type: 'div',
          props: {
            style: {
              position: 'absolute',
              left: 0, top: 0, bottom: 0,
              width: '6px',
              background: rarity.accent,
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
              background: `radial-gradient(circle, ${rarity.accent}15 0%, transparent 70%)`,
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
              color: rarity.accent,
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
        // Rarity pill
        {
          type: 'div',
          props: {
            style: {
              display: 'flex',
              padding: '8px 24px',
              borderRadius: '6px',
              backgroundColor: `${rarity.accent}20`,
              border: `1px solid ${rarity.accent}40`,
              fontSize: '18px',
              color: rarity.accent,
              letterSpacing: '3px',
            },
            children: rarity.name,
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
                  style: { color: '#33ff88', fontSize: '18px' },
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
            children: 'Register your .agent identity',
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

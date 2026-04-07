// HTTP wrapper around card-renderer.js for Cloudflare Containers.
//
// Endpoints:
//   GET  /healthz                                   → 200 "ok" (warmup probe)
//   GET  /render?id=&name=&type=&format=card        → 880x630 PNG (raw card)
//   GET  /render?id=&name=&type=&format=og          → 1200x630 PNG (card centered + padded for OG/Twitter)
//
// `format=og` composites the same Skia-rendered card onto a 1200x630 canvas
// with the matching dark background, giving social platforms a beautiful
// 1.91:1 image without changing the card's internal layout. Uses the SAME
// renderer for both formats — visual fidelity is identical to the SPA card.

import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import {
  createCanvas,
  CardDNA,
  renderCard,
  CW,
  CH,
  CARD_VERSION,
} from './src/card-renderer.js';

// Capture boot time once so /healthz can report uptime for cold-start
// observability. Worker-side code correlates this with its own Date.now()
// to detect container restarts in the middle of a busy window.
const CONTAINER_BOOT_MS = Date.now();

const app = new Hono();

// OG dimensions — 1.91:1 (Facebook/LinkedIn), close enough to Twitter's 2:1
// that the platform letterboxes only minimally. Card is 880x630 (1.4:1).
const OG_W = 1200;
const OG_H = 630;
// Background = same flat dark used inside the card. Picks up where the card's
// edges end so there's no visible seam.
const OG_BG = '#0a0d0a';

app.get('/healthz', (c) =>
  c.json({
    status: 'ok',
    renderer_version: CARD_VERSION,
    node: process.version,
    uptime_ms: Date.now() - CONTAINER_BOOT_MS,
    boot_ms: CONTAINER_BOOT_MS,
  }),
);

app.get('/render', async (c) => {
  const id = c.req.query('id');
  const name = c.req.query('name');
  const type = c.req.query('type');
  const format = (c.req.query('format') || 'card').toLowerCase();

  // Input validation — matches the worker's pre-flight check.
  if (!name) {
    return c.json({ error: 'name is required' }, 400);
  }
  if (name.length > 63) {
    return c.json({ error: 'name must be 63 characters or fewer' }, 400);
  }
  if (id && id.length > 16) {
    return c.json({ error: 'id must be 16 characters or fewer' }, 400);
  }
  if (type && !['individual', 'organization', 'agent'].includes(type.toLowerCase())) {
    return c.json({ error: 'type must be individual, organization, or agent' }, 400);
  }
  if (format !== 'card' && format !== 'og') {
    return c.json({ error: 'format must be card or og' }, 400);
  }

  // Always render the card on its native 880x630 canvas — keeps the card
  // layout identical regardless of format. Same renderer, same Skia, same
  // fonts.
  const cardCanvas = createCanvas(CW, CH);
  const dna = new CardDNA(name);
  renderCard(cardCanvas, name, dna, {
    certId: id || undefined,
    accountType: type || 'individual',
  });

  let outputCanvas;
  if (format === 'og') {
    // Composite the rendered card centered on a 1200x630 canvas. The card's
    // own background blends into the OG canvas background — visually it
    // looks like a single image with no obvious seam.
    outputCanvas = createCanvas(OG_W, OG_H);
    const ctx = outputCanvas.getContext('2d');
    ctx.fillStyle = OG_BG;
    ctx.fillRect(0, 0, OG_W, OG_H);
    const x = Math.round((OG_W - CW) / 2);
    const y = Math.round((OG_H - CH) / 2);
    ctx.drawImage(cardCanvas, x, y);
  } else {
    outputCanvas = cardCanvas;
  }

  const buffer = outputCanvas.toBuffer('image/png');

  return new Response(buffer, {
    status: 200,
    headers: {
      'Content-Type': 'image/png',
      // The Worker in front re-applies its own cache headers; this is the
      // origin response. Long max-age is fine because output is deterministic
      // from (id, name, type, format).
      'Cache-Control': 'public, max-age=31536000, immutable',
    },
  });
});

const port = Number(process.env.PORT ?? 8080);
serve({ fetch: app.fetch, port });
console.log(`[card-renderer] listening on :${port}`);

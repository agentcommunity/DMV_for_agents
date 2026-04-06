// HTTP wrapper around card-renderer.js for Cloudflare Containers.
//
// Endpoints:
//   GET  /healthz                           → 200 "ok" (warmup probe)
//   GET  /render?id=<>&name=<>&type=<>      → 880x630 PNG of the card
//
// The Worker in front of this container handles R2 caching, validation,
// and routing. This server stays minimal — just call renderCard and send
// the buffer.

import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import {
  createCanvas,
  CardDNA,
  renderCard,
  CW,
  CH,
} from './src/card-renderer.js';

const app = new Hono();

app.get('/healthz', (c) => c.text('ok'));

app.get('/render', async (c) => {
  const id = c.req.query('id');
  const name = c.req.query('name');
  const type = c.req.query('type');

  // Validation matches api/card.js
  if (!name) {
    return c.json({ error: 'name is required' }, 400);
  }
  if (name.length > 32) {
    return c.json({ error: 'name must be 32 characters or fewer' }, 400);
  }
  if (id && id.length > 16) {
    return c.json({ error: 'id must be 16 characters or fewer' }, 400);
  }
  if (type && !['individual', 'organization', 'agent'].includes(type.toLowerCase())) {
    return c.json({ error: 'type must be individual, organization, or agent' }, 400);
  }

  const canvas = createCanvas(CW, CH);
  const dna = new CardDNA(name);
  renderCard(canvas, name, dna, {
    certId: id || undefined,
    accountType: type || 'individual',
  });

  const buffer = canvas.toBuffer('image/png');

  return new Response(buffer, {
    status: 200,
    headers: {
      'Content-Type': 'image/png',
      // The Worker in front re-applies its own cache headers; this is the
      // origin response. Long max-age is fine because card output is
      // deterministic from (id, name, type).
      'Cache-Control': 'public, max-age=31536000, immutable',
    },
  });
});

const port = Number(process.env.PORT ?? 8080);
serve({ fetch: app.fetch, port });
console.log(`[card-renderer] listening on :${port}`);

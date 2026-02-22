// Vercel Serverless Function (Node.js runtime) — Rendered card PNG
//
// Uses card-renderer.js (@napi-rs/canvas Skia port) to produce the exact
// 880x630 card image. Primary key is cert ID (unique per registration).
// Name is needed for visual DNA (palette, border, pattern).
//
// Usage:
//   /api/card?id=CERT-ID&name=agent-name  → 880x630 PNG of the actual card
//   /api/card?name=agent-name             → card with generated cert ID
//   /api/card                             → redirect to /api/og (generic OG)

import {
  createCanvas,
  CardDNA,
  renderCard,
  CW,
  CH,
} from './card-renderer.js';

export default async function handler(req, res) {
  const { id, name, type } = req.query;

  // No name → can't render a card (need name for visual DNA)
  if (!name) {
    res.redirect(302, '/api/og');
    return;
  }

  const canvas = createCanvas(CW, CH);
  const dna = new CardDNA(name);
  renderCard(canvas, name, dna, {
    certId: id || undefined,
    accountType: type || 'individual',
  });

  const buffer = canvas.toBuffer('image/png');

  res.setHeader('Content-Type', 'image/png');
  res.setHeader('Cache-Control', 'public, max-age=86400, s-maxage=604800');
  res.status(200).send(buffer);
}

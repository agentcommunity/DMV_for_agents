// Vercel Edge Middleware — OG tags for card permalinks
//
// Detects crawlers hitting /c/CERT-ID/agent-name and returns minimal HTML
// with og:image pointing to /api/og. Human visitors pass through to the
// SPA (via vercel.json rewrite to /index.html).

const DMV_BASE = 'https://dmv.agentcommunity.org';

const CRAWLERS = /Twitterbot|facebookexternalhit|Facebot|LinkedInBot|Slackbot|WhatsApp|Discordbot|TelegramBot|Applebot|Googlebot|bingbot/i;

function esc(s) {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export default function middleware(request) {
  const url = new URL(request.url);
  const match = url.pathname.match(/^\/c\/([^/]+)(?:\/([^/]+))?$/);
  if (!match) return;  // passthrough

  const ua = request.headers.get('user-agent') || '';
  if (!CRAWLERS.test(ua)) return;  // passthrough — human gets SPA via rewrite

  const certId = decodeURIComponent(match[1]);
  const agentName = match[2] ? decodeURIComponent(match[2]) : '';

  const displayName = agentName ? `${agentName}.agent` : 'Agent';
  const title = `${displayName} — DMV Certificate ${certId}`;
  const description = `${displayName} is verified at the Department of Machine Verification. Certificate ID: ${certId}. Get yours at dmv.agentcommunity.org`;
  const permalink = `${DMV_BASE}/c/${encodeURIComponent(certId)}/${encodeURIComponent(agentName || 'agent')}`;
  // Full Canvas2D card (880x630) — works for iMessage/Facebook/LinkedIn (longer timeouts)
  const ogImage = `${DMV_BASE}/api/card?id=${encodeURIComponent(certId)}&name=${encodeURIComponent(agentName)}`;
  // Lightweight Satori edge function (1200x630) — fast enough for Twitter's ~4s timeout
  const twitterImage = `${DMV_BASE}/api/og?id=${encodeURIComponent(certId)}&name=${encodeURIComponent(agentName)}`;

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>${esc(title)}</title>
  <meta name="description" content="${esc(description)}">
  <meta property="og:type" content="website">
  <meta property="og:title" content="${esc(title)}">
  <meta property="og:description" content="${esc(description)}">
  <meta property="og:image" content="${esc(ogImage)}">
  <meta property="og:image:type" content="image/png">
  <meta property="og:image:width" content="880">
  <meta property="og:image:height" content="630">
  <meta property="og:url" content="${esc(permalink)}">
  <meta property="og:site_name" content="DMV - Department of Machine Verification">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${esc(title)}">
  <meta name="twitter:description" content="${esc(description)}">
  <meta name="twitter:image" content="${esc(twitterImage)}">
  <meta name="twitter:image:alt" content="DMV certificate card for ${esc(displayName)}">
  <link rel="canonical" href="${esc(permalink)}">
</head>
<body>
  <p><a href="${esc(permalink)}">${esc(title)}</a></p>
</body>
</html>`;

  return new Response(html, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'public, max-age=300, s-maxage=3600',
    },
  });
}

export const config = {
  matcher: '/c/:path*',
};

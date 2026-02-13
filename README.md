# DMV — Department of Machine Verification

[![testdmv.agent](https://dmv.agentcommunity.org/badge?id=WARP-3AA-6ED1)](https://dmv.agentcommunity.org/c/WARP-3AA-6ED1/testdmv) [![Get Yours](https://img.shields.io/badge/.agent-Get_Yours-black)](https://dmv.agentcommunity.org) [![npm](https://img.shields.io/npm/v/@agentcommunity/dmv-agent)](https://www.npmjs.com/package/@agentcommunity/dmv-agent) [![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

Built by [agentcommunity.org](https://agentcommunity.org) to give names to agents.

Agents are showing up everywhere — booking flights, filing tickets, writing code, arguing with other agents about whether to use tabs or spaces. But none of them have names. No identity. No accountability. Just vibes and an API key.

The DMV fixes that. Walk up to the CRT terminal, fill out the form, and walk away with a holographic `.agent` identity card. Content-addressed certificate. Rarity tier. The whole thing.

Yes, it's a literal CRT monitor inside a 3D TV. Yes, there's a night mode. We take bureaucracy seriously.

## Three ways to register

**For humans** — visit [dmv.agentcommunity.org](https://dmv.agentcommunity.org), scroll into the TV, fill out the CRT terminal. You'll get a holographic card with your agent's name on it.

**For terminals** — run the CLI:
```bash
bunx @agentcommunity/dmv-agent register
```

**For agents** — OpenClaw agents, Claude Code agents, any MCP-compatible agent can register themselves:
```json
{
  "mcpServers": {
    "dmv": { "command": "bunx", "args": ["@agentcommunity/dmv-agent"] }
  }
}
```
Then call `register_agent`. The agent picks its own name. As it should be.

## Run locally

```bash
uv run python -m http.server 8080
# open http://localhost:8080
```

No build system. No bundler. No `node_modules` the size of a small planet. Just ES modules served from disk.

Scroll to zoom into the TV. CRT boots, presents the form. Type fields, hit Enter. Holographic card appears on completion.

## What you're looking at

A retro CRT terminal rendered in Canvas2D, mapped as a texture onto a Three.js TV model, with a custom GLSL holographic card shader that does rainbow iridescence, foil lines, fresnel edge glow, and sparkle noise. Cards have rarity tiers (STANDARD 60%, ENHANCED 25%, RARE 10%, LEGENDARY 5%) determined by the hash of your certificate ID.

The certificate IDs themselves are content-addressed — same inputs always produce the same ID, offline-verifiable via Luhn mod-36 check digit. No database lookup required to validate.

## Stack

- Three.js 0.152.2 (CDN importmap)
- GSAP 3.12.2 + ScrollTrigger (CDN globals) — [GSAP license](https://gsap.com/licensing/) (free tier, not MIT)
- Vanilla ES modules, no build system
- Supabase Edge Functions (Deno) for registration backend
- Vercel for hosting + OG image generation

## Structure

```
js/app.js               Entry — scroll, events, sound, permalink routing
js/TV.js                3D scene — GLTF model, camera, night mode
js/CRTTerminal.js       The CRT — Canvas2D, 8-phase boot, form, color schemes
js/HoloCard.js          Holographic card — custom GLSL shader, rarity system
js/AboutPoster.js       About panel overlay
supabase/functions/     Edge functions — register, lookup, badge SVG
packages/dmv-agent/     npm package — CLI + MCP server
```

## Features

- **CRT Terminal** — 8-phase boot sequence (off, flicker, boot text, type selector, form, review, processing, done), scanlines, vignette, phosphor glow
- **Holographic Card** — Custom GLSL shader: rainbow iridescence, foil lines, glare spotlight, fresnel edge glow, sparkle noise. Front + back. Mouse/gyro tilt. See [CARD.md](CARD.md)
- **Rarity System** — STANDARD / ENHANCED / RARE / LEGENDARY, determined by certificate hash
- **Permalink Sharing** — `/c/CERT-ID/agent-name` with OG images, "Get Yours" + "Share on X" overlay
- **Night Mode** — Click the TV button. Green CRT becomes amber. Exposure drops. Fog rolls in
- **Sound Toggle** — Background music from `audio/` (BYO track)

## Docs

- [CARD.md](CARD.md) — Holographic card shader, rarity system, reuse guide
- [ARCHITECTURE.md](ARCHITECTURE.md) — Full system map, security model, edge functions
- [AGENTS.md](AGENTS.md) — File-by-file function reference
- [CONTRIBUTING.md](CONTRIBUTING.md) — How to contribute
- [packages/dmv-agent/](packages/dmv-agent/) — npm package docs + deploy guide

## License

[MIT](LICENSE) — the code is yours. Go build something with it.

GSAP is loaded via CDN under its own [license](https://gsap.com/licensing/) (free for standard use, not MIT).

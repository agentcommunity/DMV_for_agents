# Contributing to DMV

Thanks for your interest in contributing to the Department of Machine Verification.

## Getting Started

```bash
# Clone and serve — no build step needed
git clone https://github.com/agentcommunity/dmv_for_agent.git
cd dmv_for_agent
uv run python -m http.server 8080
# open http://localhost:8080
```

The frontend is vanilla ES modules served statically. Scroll to zoom into the TV, complete the CRT form, and a holographic card appears.

## Project Layout

- `js/` — Frontend modules (Three.js scene, CRT terminal, holographic card)
- `css/` — Single stylesheet with theme tokens
- `supabase/functions/` — Deno edge functions (registration, lookup, badge SVG)
- `packages/dmv-agent/` — npm package (CLI + MCP server)
- `docs/` and root `*.md` — Architecture docs, card system docs, agent reference

See [ARCHITECTURE.md](ARCHITECTURE.md) for the full system map.

## Development

**Frontend** — Edit JS/CSS, refresh the browser. No bundler, no transpilation. All deps are CDN imports via importmap.

**Edge functions** — Requires a Supabase project. Copy `.env.example` to `.env` and fill in your credentials. Deploy with `supabase functions deploy`.

**npm package** — `cd packages/dmv-agent && pnpm install && pnpm build`. Test locally with `node dist/cli.js register`.

## Pull Requests

1. Fork the repo and create a feature branch
2. Keep changes focused — one feature or fix per PR
3. Test your changes locally before submitting
4. Write a clear PR description explaining what changed and why

## Code Style

- Vanilla JS for the frontend (no TypeScript, no framework)
- TypeScript for the npm package and edge functions
- No build system for the frontend — keep it that way
- Bump `?v=N` cache-busting params in `app.js`, `TV.js`, and `index.html` together when changing imports

## Reporting Issues

Open an issue on GitHub. Include browser version and console errors if reporting a bug.

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).

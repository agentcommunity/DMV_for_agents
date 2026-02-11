# DMV — Architecture Overview

The Department of Machine Verification is the identity registration system for the [.agent community](https://agentcommunity.org). It lets agents and their operators pre-register `.agent` domain names and receive verifiable, content-addressed certificate IDs — through a retro CRT terminal on the web, a CLI, an MCP server, or a Claude Code skill.

## System Map

```
 ┌──────────────────────────────────────────────────────────────────────┐
 │                         USER'S MACHINE                              │
 │                                                                      │
 │  ┌──────────────────────────────────────────────┐                   │
 │  │  Web UI — dmv.agentcommunity.org              │                   │
 │  │                                                │                   │
 │  │  index.html  ─┬─► app.js                      │                   │
 │  │               │     ├── TV.js ── CRTTerminal   │  CRT form flow   │
 │  │               │     ├── HoloCard.js            │  Holographic card │
 │  │               │     └── AboutPoster.js         │                   │
 │  │               │                                │                   │
 │  │               └─► supabase.js ─── fetch() ─────┼──┐               │
 │  │                                                │  │               │
 │  │  Permalink: /#/CERT-ID/agent-name              │  │               │
 │  │  Overlay: "Get Yours" + "Share on X"           │  │               │
 │  └──────────────────────────────────────────────┘  │               │
 │                                                      │               │
 │  ┌──────────────────────────────────────────────┐  │               │
 │  │  NPM Package — @agentcommunity/dmv-agent      │  │               │
 │  │                                                │  │               │
 │  │  CLI:  bunx @agentcommunity/dmv-agent          │  │               │
 │  │    register   → interactive terminal flow      │  │               │
 │  │    verify     → offline check digit validation │  │               │
 │  │    (default)  → start MCP server               │  │               │
 │  │                                                │  │               │
 │  │  MCP Server (stdio):                           │  │               │
 │  │    register_agent    → POST to edge fn ────────┼──┤               │
 │  │    verify_certificate → offline, no network    │  │               │
 │  │                                                │  │               │
 │  │  JS API:                                       │  │               │
 │  │    registerAgent()   → POST to edge fn ────────┼──┤               │
 │  │    verifyCertificateId() → offline             │  │               │
 │  │                                                │  │               │
 │  │  Claude Code Skill:                            │  │               │
 │  │    /dmv → runs CLI via bunx                    │  │               │
 │  │                                                │  │               │
 │  │  ⚠ ZERO SECRETS — no DB credentials            │  │               │
 │  └──────────────────────────────────────────────┘  │               │
 └─────────────────────────────────────────────────────┼───────────────┘
                                                        │
                                        fetch() POST/GET│
                                                        │
 ┌──────────────────────────────────────────────────────┼───────────────┐
 │                      SUPABASE CLOUD                  │               │
 │                                                      │               │
 │  ┌───────────────────────────────────────────────┐  │               │
 │  │  Edge Functions (Deno)                         │◄─┘               │
 │  │                                                │                   │
 │  │  POST /register-agent                          │                   │
 │  │    → validate input + registration_type        │                   │
 │  │    → rate limit: 3/email/hr, 10/IP/hr          │                   │
 │  │    → generate certificate ID (FNV-1a + Luhn)   │                   │
 │  │    → INSERT into registrations (status:         │                   │
 │  │      pending_profile, user_id: NULL)            │                   │
 │  │    → return cert ID + permalink + badge URLs   │                   │
 │  │    → DB trigger fires → agentcommunity.org     │                   │
 │  │      creates auth user + sends magic link +    │                   │
 │  │      certificate email (async via pg_net)      │                   │
 │  │                                                │                   │
 │  │  GET /lookup-agent?id=CERT-ID                  │                   │
 │  │    → single result (cert IDs are unique)       │                   │
 │  │  GET /lookup-agent?domain=name                 │                   │
 │  │    → array (multiple pre-registrations)        │                   │
 │  │                                                │                   │
 │  │  GET /badge?id=CERT-ID&style=flat|card         │                   │
 │  │    → SVG badge (cert ID only, domain lookup    │                   │
 │  │      deprecated — ambiguous with multi-prereg) │                   │
 │  │                                                │                   │
 │  │  🔑 Holds SUPABASE_SERVICE_ROLE_KEY            │                   │
 │  └──────────────────────┬────────────────────────┘                   │
 │                          │                                            │
 │  ┌──────────────────────▼────────────────────────┐                   │
 │  │  PostgreSQL — registrations table              │                   │
 │  │                                                │                   │
 │  │  registration_type  TEXT (INDIVIDUAL/ORG/AGENT)│                   │
 │  │  domain_requested   TEXT (not unique — pre-reg)│                   │
 │  │  certificate_id     TEXT (UNIQUE partial index) │                   │
 │  │  email              TEXT                       │                   │
 │  │  signup_source      TEXT (ui/cli/mcp/api)      │                   │
 │  │  status             TEXT (pending_profile)     │                   │
 │  │  user_id            UUID (nullable — set by    │                   │
 │  │                      trigger, not by DMV)      │                   │
 │  │  full_name          TEXT (nullable)            │                   │
 │  │  organization_name  TEXT (nullable)            │                   │
 │  │  metadata           JSONB                      │                   │
 │  │  created_at         TIMESTAMPTZ                │                   │
 │  │                                                │                   │
 │  │  RLS: deny all for anon (service key bypasses) │                   │
 │  │                                                │                   │
 │  │  Trigger: on_dmv_registration (AFTER INSERT    │                   │
 │  │    WHERE certificate_id IS NOT NULL)           │                   │
 │  │    → calls agentcommunity.org edge function    │                   │
 │  │    → creates/finds auth user, sends emails     │                   │
 │  └────────────────────────────────────────────────┘                   │
 └──────────────────────────────────────────────────────────────────────┘
```

## Five ways to register

| Method | How | Who it's for |
|--------|-----|-------------|
| **Web terminal** | Visit dmv.agentcommunity.org, complete CRT form | Humans exploring |
| **CLI** | `bunx @agentcommunity/dmv-agent register` | Developers in a terminal |
| **MCP tool** | Claude calls `register_agent` tool via stdio | Autonomous agents |
| **JS API** | `import { registerAgent }` from the package | Agent frameworks |
| **Claude Code skill** | `/dmv` slash command | Claude Code users |

All five paths call the same edge function. Zero database credentials on the client.

## Repository structure

```
threejs_box_design_dmv/
│
├── index.html                    Web UI entry point (importmap, GSAP, Inter wordmark font, CSS)
├── css/styles.css                All styles (theme tokens, layout, center `.agent` mark, responsive)
├── js/
│   ├── app.js                    Main: events, scroll, permalink, zoom, sound, clock, theme/favicon sync
│   ├── TV.js                     Three.js scene: GLTF model, camera, zoom, night mode
│   ├── CRTTerminal.js            Canvas2D CRT: 8-phase boot, form, validation, effects
│   ├── HoloCard.js               Holographic card: ShaderMaterial, rarity, identicon, QR
│   ├── AboutPoster.js            About panel: PPSupply fonts, show/hide, zoom, theme-aware text colors
│   ├── CardPoster.js             [Legacy] Original flat card — replaced by HoloCard
│   └── supabase.js               Registration client: fetch() to edge function
│
├── images/                       Favicons: favicon.ico + favicon_dark.ico
├── fonts/                        PPSupply font files (4 .otf)
├── models/                       3D models (tv1.glb)
├── audio/                        Background track(s) (user-provided, optional)
│
├── supabase/functions/
│   ├── register-agent/index.ts   POST — registration proxy (validate, rate limit, insert)
│   ├── lookup-agent/index.ts     GET — public read-only lookup by cert ID or domain
│   └── badge/index.ts            GET — SVG badge generator (flat + card styles)
│
├── packages/dmv-agent/           NPM package: @agentcommunity/dmv-agent
│   ├── src/
│   │   ├── cli.ts                CLI binary (register, verify, serve)
│   │   ├── mcp-server.ts         MCP server (register_agent, verify_certificate)
│   │   ├── register.ts           Core registration (validate → POST to edge fn)
│   │   ├── certificate.ts        FNV-1a hash + Luhn mod-36 cert ID generation
│   │   ├── validate.ts           Agent name, email validation
│   │   ├── types.ts              TypeScript interfaces
│   │   └── index.ts              Public API exports
│   ├── skills/dmv/SKILL.md       Claude Code /dmv skill
│   ├── package.json              pnpm, only dep: @modelcontextprotocol/sdk
│   ├── README.md                 Package docs (quick start, API, security, architecture)
│   └── DEPLOY.md                 Go-live checklist (DB, edge fns, npm publish, monitoring)
│
├── llms.txt                      LLM-readable site description
├── CLAUDE.md                     Instructions for Claude Code agents
├── AGENTS.md                     Terse code reference for agents
└── ARCHITECTURE.md               ← this file
```

## Certificate ID system

Content-addressed, deterministic, offline-verifiable.

```
Input:   "my-assistant" + "user@example.com" + "agent"
          ↓
FNV-1a:  32-bit hash → word index + 6 hex chars
          ↓
Luhn:    mod-36 check digit appended
          ↓
Output:  MESA-DD6-660J

Format:  WORD-XXX-XXXC
         │     │    └─ check digit (Luhn mod-36)
         │     └────── 6 hex chars from hash
         └──────────── 1 of 32 words (NOVA, APEX, FLUX, ...)
```

- Same inputs → same ID (deterministic)
- Anyone can verify offline (check digit, ~10 lines in any language)
- Cannot be enumerated or predicted (not sequential)

## Security model

```
Principle: never trust the client.

Client code:     validates → POST JSON → reads response
                 (no secrets, no DB access, just fetch())

Edge function:   validates again → rate limits → generates cert → INSERTs
                 (holds service role key, server-side authority)

Database:        RLS denies all anon access
                 (only reachable through edge function with service key)
```

| Threat | Mitigation |
|--------|-----------|
| Spam registrations | Rate limit: 3/email/hr, 10/IP/hr (database-backed, not in-memory) |
| Name squatting | Pre-registration model — multiple users can claim the same domain. Magic link email verifies identity. |
| Credential theft | No credentials in client code. Anon key removed. Only edge fn URL is public. |
| Data exfil | lookup-agent returns only public fields. No email, no IP, no operator name. |
| DDoS on edge fn | Supabase built-in DDoS protection + rate limiting in function code |

## Badges

SVG badges embed in any website or README, always linking back to dmv.agentcommunity.org.

**Flat badge** (GitHub READMEs — shields.io style):
```
GET /badge?id=MESA-DD6-660J
```

**Card badge** (websites — branded, 280x72):
```
GET /badge?id=MESA-DD6-660J&style=card
```

Note: `?domain=` is deprecated (ambiguous with multiple pre-registrations per domain). Use `?id=CERT-ID`.

Embed code:
```markdown
[![my-assistant.agent](https://dmv.agentcommunity.org/badge?id=MESA-DD6-660J)](https://dmv.agentcommunity.org/#/MESA-DD6-660J/my-assistant)
```

## Relationship to .agent community

The DMV is one piece of a larger ecosystem:

| Project | What | Where |
|---------|------|-------|
| **agentcommunity.org** | Mission, membership, .agent ICANN application | agentcommunity.org |
| **AID** | DNS-based Agent Identity & Discovery protocol | aid.agentcommunity.org |
| **DMV** | Pre-registration terminal + badge + API (this repo) | dmv.agentcommunity.org |

The DMV serves as the **identity layer for the pre-ICANN era**. Before `.agent` domains exist in DNS, the DMV certificate ID is the verifiable agent identity. When `.agent` launches, DMV registrations feed into the official DNS-based AID system.

## Tech stack

| Layer | Technology | Notes |
|-------|-----------|-------|
| Web UI | Three.js 0.152.2, GSAP 3.12.2, Canvas2D | No build system, native ES modules |
| NPM package | TypeScript, MCP SDK | pnpm for dev, bunx for users |
| Edge functions | Deno (Supabase Edge Functions) | Auto-deployed env vars |
| Database | PostgreSQL (Supabase) | RLS, unique constraints |
| Hosting (web) | Static files (Vercel/Netlify/any CDN) | No SSR needed |
| Hosting (API) | Supabase Edge Functions | Free tier, no VPS needed |

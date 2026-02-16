# DMV — Department of Machine Verification

The DMV is the identity pre-registration system for the [.agent community](https://agentcommunity.org).

The .agent community is building toward an ICANN application for the `.agent` generic top-level domain (gTLD). Pre-registering now establishes early interest in your preferred `.agent` domain name — like reserving `your-name.agent` before the namespace opens.

Pre-registration is not a guarantee of domain assignment. It records your interest and gives you a verifiable certificate ID.

---

## What is .agent?

`.agent` is a proposed internet domain extension (like `.com` or `.io`) specifically for AI agents. When approved by ICANN, it will give every AI agent a unique, verifiable identity on the internet — like `atlas.agent` or `helper.agent`.

The .agent community is the group building this. The DMV is where you come to stake your claim.

---

## Who is this for?

### For individuals

You're a person who builds or operates an AI agent and want to reserve a name for it.

**How to pre-register:**
1. Go to [dmv.agentcommunity.org](https://dmv.agentcommunity.org)
2. Scroll down to the CRT terminal
3. Select "Individual"
4. Fill in your name, your agent's name, and your email
5. Accept the terms and charter
6. Check your email for the verification link

You'll get a certificate ID (like `MESA-DD6-660J`) and a holographic identity card you can share.

### For organizations

Your company builds AI agents and wants to reserve names for them.

**How to pre-register:**
1. Go to [dmv.agentcommunity.org](https://dmv.agentcommunity.org)
2. Scroll down to the CRT terminal
3. Select "Organization"
4. Fill in your organization name, agent name, and a company email
5. Accept the terms and charter
6. Check your email for the verification link

Organization registrations require a non-consumer email domain (no gmail.com, etc.).

### For AI agents

Your agent can pre-register itself. The CLI is designed for agentic workflows — AI agents running in terminals, CI pipelines, or Claude Code sessions.

**How to pre-register:**

```bash
npx @agentcommunity/dmv-agent register
```

This opens an interactive CRT terminal in your shell. The agent provides its name and the operator's details. The operator (the human or org responsible) must verify via email.

For non-interactive use (scripting, CI, autonomous agents):

```bash
npx @agentcommunity/dmv-agent register \
  --name my-agent \
  --email operator@example.com \
  --operator "Acme Labs"
```

For Claude Code or other MCP-compatible tools, add the MCP server:

```json
{
  "mcpServers": {
    "dmv": {
      "command": "npx",
      "args": ["@agentcommunity/dmv-agent"]
    }
  }
}
```

See the [npm package docs](packages/dmv-agent/README.md) for full CLI, MCP, and API reference.

---

## After pre-registration

### Your certificate

Every pre-registration gets a unique certificate ID:

```
MESA-DD6-660J
│     │    └─ check digit (Luhn mod-36)
│     └────── hash of your registration
└──────────── word from the DMV dictionary
```

You can verify any certificate offline:

```bash
npx @agentcommunity/dmv-agent verify MESA-DD6-660J
```

### Your holographic card

The web terminal generates a holographic identity card with rarity tiers (STANDARD, ENHANCED, RARE, LEGENDARY) determined by your certificate hash. Share it via permalink:

```
https://dmv.agentcommunity.org/c/MESA-DD6-660J/my-agent
```

### Badges for your project

Show your `.agent` identity in your README or website:

**Flat badge (for GitHub READMEs):**
```markdown
[![my-agent.agent](https://dmv.agentcommunity.org/badge?id=CERT-ID)](https://dmv.agentcommunity.org/c/CERT-ID/my-agent)
```

**Card badge (for websites):**
```html
<a href="https://dmv.agentcommunity.org/c/CERT-ID/my-agent">
  <img src="https://dmv.agentcommunity.org/badge?id=CERT-ID&style=card"
       alt="my-agent.agent — DMV Certificate" />
</a>
```

Badges verify live against the DMV database. Green = verified, yellow-green = pending, red = invalid.

---

## How it works

```
┌─────────────────────────────────────────────────────────────┐
│                                                             │
│   CRT Terminal (web)  ──┐                                   │
│   CLI (agents)        ──┼──▶  Supabase Edge Function        │
│   MCP (Claude Code)   ──┘    (validates, rate limits,       │
│                               generates cert, stores)       │
│                                      │                      │
│                              Database trigger fires          │
│                                      │                      │
│                              agentcommunity.org              │
│                              (sends verification email,      │
│                               creates auth user)             │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

1. You submit your pre-registration (web, CLI, or MCP)
2. Server validates, rate limits, generates your certificate ID
3. Record stored with status `pending_profile`
4. A database trigger sends a verification email to the operator
5. Clicking the verification link completes pre-registration
6. Your `.agent` domain interest is recorded for when the gTLD launches

**Pre-registration model:** Multiple parties can express interest in the same domain name. The certificate ID is unique to your specific registration (same inputs = same cert ID). Domain assignment happens later through the .agent community governance process.

### Rate limiting

To prevent abuse:
- **Per email:** 3 pre-registrations per hour
- **Per IP:** 10 pre-registrations per hour
- **Per machine (CLI):** 3 per 24 hours (tracked locally + server-side fingerprint)

### Security

- Zero secrets in client code — all database writes go through edge functions
- Certificate IDs are content-addressed hashes, not sequential — can't be guessed or enumerated
- Email verification required — name squatters can't activate without owning the email
- All data stored securely on Supabase with row-level security

---

## Development

### Run the web terminal locally

```bash
uv run python -m http.server 8080
# open http://localhost:8080
```

No build system. Native ES modules via browser importmap.

### Run the CLI locally

```bash
cd packages/dmv-agent
pnpm install && pnpm build
node dist/cli.js register
```

### Deploy edge functions

```bash
supabase functions deploy register-agent lookup-agent badge
```

### Project structure

```
index.html                  Web terminal entry point
css/styles.css              Styles, theme tokens, layout
js/
  app.js                    Entry — events, scroll, routing
  TV.js                     Three.js scene — 3D TV model, camera, renderer
  CRTTerminal.js            CRT terminal — Canvas2D, boot sequence, form
  HoloCard.js               Holographic card — GLSL shader, rarity, tilt
  AboutPoster.js             About panel
  supabase.js               Registration API client
packages/dmv-agent/         npm package — CLI, MCP server, JS API
supabase/functions/         Edge functions — register, lookup, badge
```

### Docs

- [CARD.md](CARD.md) — Holographic card shader, rarity system
- [ARCHITECTURE.md](ARCHITECTURE.md) — Full system architecture, security model
- [packages/dmv-agent/README.md](packages/dmv-agent/README.md) — CLI, MCP, API, badge docs
- [packages/dmv-agent/DEPLOY.md](packages/dmv-agent/DEPLOY.md) — Go-live checklist

---

## Links

- [dmv.agentcommunity.org](https://dmv.agentcommunity.org) — Live web terminal
- [agentcommunity.org](https://agentcommunity.org) — The .agent community
- [@agentcommunity/dmv-agent](https://www.npmjs.com/package/@agentcommunity/dmv-agent) — npm package

## License

MIT

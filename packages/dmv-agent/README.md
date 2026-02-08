# @agentcommunity/dmv-agent

Register `.agent` identities at the **Department of Machine Verification**.

Pre-register a unique agent name, get a content-addressed certificate ID, and verify it cryptographically — all from the terminal or from inside Claude Code.

## Quick start

### Claude Code skill (recommended)

Copy the skill into your project:

```bash
mkdir -p .claude/skills
cp -r node_modules/@agentcommunity/dmv-agent/skills/dmv .claude/skills/
```

Then in Claude Code, type `/dmv` to start registration.

### CLI

```bash
# Register interactively
bunx @agentcommunity/dmv-agent register

# Verify a certificate ID
bunx @agentcommunity/dmv-agent verify MESA-DD6-660J
```

`npx` works too if you don't have bun.

### MCP server (for autonomous agents)

Add to your Claude Code settings (`.claude/settings.json`):

```json
{
  "mcpServers": {
    "dmv": {
      "command": "bunx",
      "args": ["@agentcommunity/dmv-agent"]
    }
  }
}
```

This exposes two tools to Claude:

| Tool | Description |
|------|-------------|
| `register_agent` | Register an .agent identity (agent_name, email, operator_name?, description?) |
| `verify_certificate` | Check a certificate ID's Luhn mod-36 check digit |

## How it works

### Registration flow

```
Client (your machine)              Server (Supabase Edge Function)
─────────────────────              ────────────────────────────────
validate input locally
        │
        ├── POST /register-agent ──▶  validate again
                                      rate limit (by email + IP)
                                      generate certificate ID
                                      insert into database
                                      ◀── return certificate
        │
display result
```

1. **Client-side validation** — fast feedback. Agent name: 3-32 lowercase alphanumeric + hyphens. Email: basic format check.
2. **Server-side validation** — same checks repeated. Rejects anything the client might skip.
3. **Rate limiting** — max 3 registrations per email per hour, max 10 per IP per hour. Enforced server-side via database queries. Cannot be bypassed by restarting the client.
4. **Certificate ID** — generated server-side. Content-addressed via FNV-1a hash, formatted as `WORD-XXX-XXXC` with a Luhn mod-36 check digit. Deterministic: same inputs always produce the same ID.
5. **Pre-registration** — the record is stored but marked unverified. A verification email is sent.
6. **Verification** — clicking the email link completes registration. Until then, the name is reserved but not active.

### Certificate ID format

```
MESA-DD6-660J
│     │    └─ Luhn mod-36 check digit
│     └────── 6 hex chars from FNV-1a hash
└──────────── word from 32-word dictionary
```

Anyone can verify a certificate ID offline — no network call needed:

```bash
bunx @agentcommunity/dmv-agent verify MESA-DD6-660J
# ✓ Certificate MESA-DD6-660J has a valid check digit.
```

## Programmatic use

```ts
import { registerAgent, verifyCertificateId } from '@agentcommunity/dmv-agent';

// Register (calls edge function, no DB credentials needed)
const result = await registerAgent({
  agentName: 'my-assistant',
  email: 'operator@example.com',
  operatorName: 'Acme Corp',       // optional
  description: 'A helpful assistant', // optional
}, 'api');

console.log(result.certificateId); // MESA-DD6-660J
console.log(result.domain);       // my-assistant.agent

// Verify (offline, no network)
verifyCertificateId('MESA-DD6-660J'); // true
```

## Security

**No database credentials in client code.** The published package contains zero secrets.

```
┌─────────────────┐         ┌──────────────────────────┐         ┌───────────┐
│  Claude Code     │──stdio─▶│  dmv-agent (your machine) │──https─▶│  Supabase │
│  (or any agent)  │         │  no secrets, just fetch() │         │  Edge Fn  │
└─────────────────┘         └──────────────────────────┘         │  (has key)│
                                                                  └───────────┘
```

- **Edge function proxy** — all database writes go through a Supabase Edge Function that holds the service role key. Clients only know the function URL (public endpoint).
- **Server-side rate limiting** — by email and IP, via database queries. Survives client restarts, can't be bypassed.
- **Duplicate protection** — unique constraint on domain name. Registering `my-agent.agent` twice returns a 409.
- **Email verification** — registration is pre-registration until the verification link is clicked. Name squatters can't activate without owning the email.
- **Content-addressed IDs** — certificate IDs are deterministic hashes, not sequential, so they can't be enumerated or predicted.
- **Input validation** — strict format rules enforced both client-side (fast feedback) and server-side (security boundary).

## Architecture

```
┌──────────────────────────────────┐
│  Published npm package           │
│  @agentcommunity/dmv-agent       │
│                                  │
│  ┌─────────┐  ┌──────────────┐  │
│  │ CLI      │  │ MCP server   │  │    ┌──────────────────────┐
│  │ register │  │ register_agent│ ├───▶│ Supabase Edge Function│
│  │ verify   │  │ verify_cert  │  │    │ register-agent        │
│  └─────────┘  └──────────────┘  │    │                      │
│                                  │    │ • validates           │
│  ┌─────────────────────────┐    │    │ • rate limits (IP+email)│
│  │ JS API                   │    │    │ • generates cert ID   │
│  │ registerAgent()          │────┘    │ • inserts to DB       │
│  │ verifyCertificateId()    │         │ • holds service key   │
│  └─────────────────────────┘         └──────────────────────┘
│                                               │
│  ┌─────────────────────────┐         ┌────────▼──────────┐
│  │ Claude Code skill        │         │   Supabase DB     │
│  │ /dmv slash command       │         │   registrations   │
│  └─────────────────────────┘         └───────────────────┘
└──────────────────────────────────┘
```

- The npm package runs **locally**. It contains no database credentials.
- All writes go through the **edge function** (server-side), which holds the service role key.
- Certificate verification is **offline** — no network call needed.
- The Claude Code skill is a **prompt template** that invokes the CLI.

## Development

```bash
pnpm install
pnpm build        # compile TypeScript
pnpm dev          # watch mode
pnpm start        # run MCP server directly
```

### Deploying the edge function

```bash
supabase functions deploy register-agent
```

The function reads `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` from Supabase's automatic environment variables — no manual config needed.

## License

MIT

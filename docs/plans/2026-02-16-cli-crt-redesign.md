# CLI CRT Terminal Redesign

## Summary

Redesign the `dmv-agent register` CLI to mirror the web CRT terminal experience. ASCII art TV frame, green ANSI colors, step-by-step form flow, about/terms/charter readable, triple-layer rate limiting, and clear messaging that this is an agentic pre-registration flow.

## Key Decisions

- **Pre-registration, not registration.** All copy says "pre-registration." Not a guarantee of assignment.
- **Agent-only flow.** Humans & organizations directed to dmv.agentcommunity.org.
- **Operator name is required** (not optional).
- **CRT terminal mirror** visual style — ASCII frame, green text, scanline vibes.
- **Triple-layer rate limiting:** client-side lockfile + server fingerprint + existing server limits.

## Visual Design

### Boot Screen
- ASCII art CRT frame using box-drawing characters
- Green ANSI color (#33ff88 equivalent = ANSI green/bright green)
- Title: "DMV — DEPARTMENT OF MACHINE VERIFICATION"
- Subtitle: "Machine Identity & Pre-Registration Terminal v1.0"
- "AGENTIC PRE-REGISTRATION" header
- Callout box: humans & orgs → dmv.agentcommunity.org
- Menu: [a] About  [t] Terms  [c] Charter  [ENTER] Continue
- Version line at bottom

### Form Flow (step by step, one field at a time)
1. Agent name (lowercase, 3-32 chars, validated inline)
2. Operator name (required)
3. Operator email (verification link sent here)
4. Description (optional, Enter to skip)
5. Confirmation summary box + terms acceptance + Y/n gate

### Success Screen
- Processing bar animation
- Certificate ID, domain, status
- "CHECK YOUR EMAIL" callout box
- Link to view certificate on web

### Rate Limit Screen
- Machine ID shown (truncated hash)
- Time remaining until next attempt
- Usage count (e.g. "3/3 used in 24h")

## Rate Limiting

### Client-side
- `~/.dmv-agent/registrations.json` stores: `{ fingerprint, attempts: [{ timestamp, agentName }] }`
- Machine fingerprint: SHA-256 of `hostname + username + platform`
- Max 3 pre-registrations per machine per 24h
- Cooldown displayed: "Try again in Xh Xm"

### Server-side
- Send `machine_fingerprint` field with registration request
- Edge function enforces per-fingerprint limits (new)
- Existing: per-email (3/hr), per-IP (10/hr)

## Architecture

### New file: `src/ui.ts`
- CRT frame renderer (fixed-width ASCII art)
- ANSI color helpers (green, dim, bright, red for errors)
- Box drawing utilities
- Progress bar renderer

### Modified: `src/cli.ts`
- Replace bare `console.error` + `readline` with CRT-framed UI
- Step-by-step form flow with validation
- Boot screen with about/terms/charter menu
- Confirmation gate before submit

### New file: `src/rate-limit.ts`
- Machine fingerprint generation
- Local lockfile read/write (~/.dmv-agent/)
- Check/enforce limits
- Fingerprint sent to server

### Modified: `src/register.ts`
- Accept and send `machine_fingerprint` field

### Content files (inline strings, not separate files)
- About text
- Terms summary
- Charter summary

## Zero New Dependencies

Node built-ins only: `readline`, `os`, `crypto`, `fs`, `path`.
No chalk, no inquirer, no boxen. Raw ANSI escape codes.

# Text Surface Audit

Purpose: keep user-facing language aligned across web CRT, agent CLI, cards, badges, metadata, and docs.

## Commands

Run the human-readable audit:

```bash
npm run text:audit
```

Run strict checks (fails on critical drift):

```bash
npm run text:check
```

Export JSON for automation/diffing:

```bash
npm run text:audit:json
```

Write a report file:

```bash
node scripts/text-surfaces/run-audit.mjs --out docs/reports/text-surface-audit.txt
```

## What it checks

- Claim coverage by surface:
  - pre-registration language
  - non-binding/no-assignment language
  - verification email language
  - certificate ID, permalink, badge, share, AID, audience framing, terms/charter
- Critical invariants:
  - Core docs mention non-binding pre-registration
  - Agent runtime surfaces mention email verification
  - Share surfaces include permalink format
  - Browser and server card renderers use the same right-column field labels
- Drift warnings:
  - web CRT vs agent CLI reminder gaps
  - pending backend status vs "VERIFIED" card language

Accepted exceptions are codified in `/Users/user/dev/PROJECTS/AgentCommunity/AgentCommunity_DMV/scripts/text-surfaces/audit-lib.mjs` (`ACCEPTED_EXCEPTIONS`) so intentional product decisions show as accepted, not generic warnings.

## Accepted Exceptions

Current accepted exceptions and rationale:

1. `status-language-drift`
   - Behavior: DB registration row starts at `status = 'pending_profile'` (PAGE's default on the shared registrations table), but the card text shows `STATUS: VERIFIED`. DMV does not set the status column — it relies on `certificate_id IS NOT NULL` as the DMV marker. The gap isn't `provisional → verified` (as earlier versions of this doc described); it's "card says VERIFIED before the operator has signed in to claim the domain."
   - Rationale: card is a static public artifact and should not reflect internal verification-state transitions.
2. `web-crt-email-reminder-gap`
   - Behavior: web CRT completion screen does not add extra verification reminder copy.
   - Rationale: verification/link/badge details are delivered via follow-up email flow; keep CRT completion surface minimal.

If either decision changes, update `ACCEPTED_EXCEPTIONS` in:

- `/Users/user/dev/PROJECTS/AgentCommunity/AgentCommunity_DMV/scripts/text-surfaces/audit-lib.mjs`

Then run:

```bash
npm run text:audit
npm run text:check
```

## Change Log

### 2026-02-23 (v2)

- QR label changed from "VERIFY" to "SCAN" across both card renderers — no audit impact (not a tracked claim).
- Save card feature added to CLI success screen, SKILL.md, README.md — share claim now covers save card text too.
- Card field parity check still passes — no new `drawField()` calls added.

### 2026-02-23

- Added text-surface audit harness and strict tests.
- Added claim matrix across web CRT, share/permalink, card renderers, metadata, docs, CLI, MCP, and API surfaces.
- Added critical alignment rules + card field parity checks.
- Converted two known drifts into accepted exceptions with explicit rationale.

## Suggested review prompt

After running `npm run text:audit`, use this prompt in your reviewer/assistant:

```text
Review this DMV text surface audit. Identify claim mismatches, audience confusion, and distracting copy. Propose concrete edits by file and include exact replacement text where possible.
```

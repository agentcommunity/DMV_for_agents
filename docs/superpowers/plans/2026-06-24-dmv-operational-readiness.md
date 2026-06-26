# DMV Operational Readiness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the DMV launch path ready for operation across registration, auth, email, Supabase flow, card rendering, CLI smoke coverage, and main-app card display.

**Architecture:** Keep DMV as the source of truth for card rendering and registration. The main app only reads certificate rows already linked into `user_domains` and displays DMV-rendered `/api/card` images. Registration continues through the DMV Worker proxy into Supabase, with PAGE handling auth-user linking and transactional email.

**Tech Stack:** Cloudflare Workers, Supabase Edge Functions, Supabase Auth, Resend email gateway, Next.js 16, React 19, TypeScript, Vitest, Deno tests, Node test runner.

---

## Worktrees

- DMV: `/Users/team/dev/PROJECTS/AgentCommunity/AgentCommunity_DMV/.worktrees/codex-dmv-operational-readiness`
- Main app: `/Users/team/dev/PROJECTS/AgentCommunity/agentCommunity_PAGE/.worktrees/codex-dmv-cards-main`

Baseline already verified:

- Main app: `pnpm lint`, `pnpm test`
- DMV: `pnpm check`, `pnpm build`

Current status:

- Local implementation and review are complete in both worktrees.
- Production deploy, flag flip, real email receipt, and production Supabase evidence remain intentionally pending until an approved launch smoke inbox is available.

## Task 1: Show DMV Cards In The Members Domains Room

**Files:**
- Modify main app: `features/members/components/dashboard/domains-section.tsx`
- Modify main app: `features/members/components/workspace/members-room-outlet.tsx`
- Test main app: `features/members/components/dashboard/__tests__/domains-section.test.tsx`
- Optionally update main app docs: `features/members/MEMBERS.md`

- [x] Add `agentCertificates` and `registrationType` props to `DomainsSection`.
- [x] Render `AgentCardsSection` inside the Domains room below the domain list/add flow so both org and individual members can see minted cards from `user_domains.certificate_id`.
- [x] Keep the existing `NEXT_PUBLIC_SHOW_AGENT_CARDS` gate inside `AgentCardsSection`; the launch switch stays operationally controlled by env.
- [x] Add a jsdom component test that sets `NEXT_PUBLIC_SHOW_AGENT_CARDS=true`, passes one certificate, and asserts the DMV card image URL uses `https://dmv.agentcommunity.org/api/card?id=<cert>&name=<bare-name>&type=<individual|organization>`.
- [x] Update `features/members/MEMBERS.md` so the Domains room documentation names DMV cards as part of the room, not only the org Overview room.
- [x] Verify with `pnpm test -- features/members/components/dashboard/__tests__/domains-section.test.tsx features/members/components/workspace/__tests__/members-room-outlet.test.tsx features/members/hooks/__tests__/use-members-dashboard.test.tsx`.

## Task 2: Harden DMV CLI Package And Add Smoke Coverage

**Files:**
- Modify DMV: `packages/dmv-agent/src/types.ts`
- Modify DMV: `packages/dmv-agent/src/register.ts`
- Modify DMV: `packages/dmv-agent/src/cli.ts`
- Modify DMV: `packages/dmv-agent/src/mcp-server.ts`
- Modify DMV: `packages/dmv-agent/src/validate.ts`
- Modify DMV: `tests/dmv-agent-cli.test.mjs`
- Modify DMV: `scripts/build-root.mjs`
- Optionally update DMV docs: `AUTH_DMV.md`, `packages/dmv-agent/README.md`, `packages/dmv-agent/DEPLOY.md`

- [x] Return `permalinkUrl`, `badgeUrl`, and `badgeCardUrl` from `registerAgent()` when the Worker returns them.
- [x] Use those URLs in CLI and MCP success output instead of reconstructing only the permalink locally.
- [x] Replace hardcoded `0.1.0` CLI/MCP version strings with the package version from `package.json`, using JSON import assertions or another TypeScript-safe runtime pattern.
- [x] Extend CLI-side validation to cover required operator name, maximum operator length, and maximum description length before network submission.
- [x] Add Node smoke tests that build the package, run `node packages/dmv-agent/dist/cli.js verify MESA-DD6-660J`, assert invalid IDs exit non-zero, and assert invalid non-interactive registration fails before network calls.
- [x] Add `dmv-agent doctor` as a read-only endpoint readiness check for `/healthz`, `/api/card`, `/badge`, and validation-only `/api/register {}`.
- [x] Expose the same read-only doctor check as MCP tool `dmv_doctor` for persistent agent hosts.
- [x] Update `scripts/build-root.mjs` so `pnpm build` runs the CLI smoke tests after the TypeScript build.
- [x] Verify with `pnpm build`.

## Task 3: Add DMV Email/Auth Template Coverage And Docs

**Files:**
- Modify main app: `supabase/functions/email/shared/templates/__tests__/dmv-certificate.test.ts`
- Modify main app: `supabase/functions/email/shared/templates/__tests__/dmv-verify.test.ts`
- Modify main app docs: `docs/RESEND.md`
- Modify main app docs: `features/members/MEMBERS.md` if Task 1 did not update it

- [x] Add Deno tests for `dmv-certificate` verifying the inline image is a PNG `/api/card` URL, the X/LinkedIn/share links include the permalink, the markdown badge uses `/badge?id=`, and hostile domain/cert/name values are escaped.
- [x] Add Deno tests for `dmv-verify` verifying the magic link is HTML-escaped, no six-digit OTP copy is present, and the subject matches the DMV verification flow.
- [x] Update `docs/RESEND.md` to state that DMV sends two emails: a direct personal-sender magic-link verify email for brand-new auth users and a queued `dmv_certificate` template through the gateway for every certificate.
- [x] Verify with Deno if available: `deno test supabase/functions/email/shared/templates/__tests__/dmv-certificate.test.ts supabase/functions/email/shared/templates/__tests__/dmv-verify.test.ts`.
- [x] Verify main app with `pnpm lint` and the focused Vitest tests touched by Task 1.

## Task 4: Final Readiness Verification

**Files:**
- Update DMV: `packages/dmv-agent/DEPLOY.md` if launch checklist gaps remain
- Update DMV: `AGENT_HANDOFF.md` if material go-live status changes
- Update main app: `docs/AGENT-HANDOFF.md` if material go-live status changes

- [x] Run main app `pnpm lint && pnpm test && pnpm build` unless build is blocked by live env constraints.
- [x] Run DMV `pnpm check && pnpm build`.
- [x] Run live-safe endpoint checks only for read-only paths: `/api/card`, `/api/og`, `/badge`, and direct Supabase `register-agent` no-header rejection. Do not create production rows unless the user explicitly approves a live registration test email.
- [x] Summarize remaining launch risks, exact env flips (`NEXT_PUBLIC_SHOW_AGENT_CARDS`, `FEATURE_DMV_REGISTRATION_ENABLED`, DMV secrets), and suggested agentic experience upgrades.

Pending launch-only proof:

- [ ] Deploy Supabase functions (`handle-dmv-registration`, `email-gateway`) and DMV/main Workers.
- [ ] Flip `NEXT_PUBLIC_SHOW_AGENT_CARDS=true` in the main app deploy.
- [ ] Run approved production new-user and existing-user smoke registrations with a controlled inbox.
- [ ] Confirm real certificate email, direct verify email for the new-user path, magic-link auth, `user_domains` linkage, and `/members?room=domains` card rendering with `pnpm dmv:evidence`.

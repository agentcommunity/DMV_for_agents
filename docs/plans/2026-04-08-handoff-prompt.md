# Fresh-context handoff prompt — DMV API Hardening execution

**This file is a prompt, not a plan.** Copy the content between the lines below into a new Claude Code session to start executing the plan. The new session starts with zero context from the session that wrote the plan.

---

I need you to execute the DMV API Hardening plan at:

**`/Users/user/dev/PROJECTS/AgentCommunity/AgentCommunity_DMV/.worktrees/api-hardening/docs/plans/2026-04-08-dmv-api-hardening-plan.md`**

This plan adds a `/api/register` worker proxy in front of the Supabase `register-agent` edge function with Invisible Cloudflare Turnstile for browser flows and a KV-backed 24h per-fingerprint cooldown for CLI/MCP flows. It closes the "API hardening" known gap deferred from a previous CF-native hardening plan, and it aligns DMV's rate limiting with the main `agentCommunity_PAGE` repo by sharing CF Rate Limiting namespace IDs at the Cloudflare account level — one counter, two properties — and killing Upstash from DMV entirely.

## Context you need before starting

1. **A worktree already exists with the plan and infrastructure set up.** Work inside:

   ```
   /Users/user/dev/PROJECTS/AgentCommunity/AgentCommunity_DMV/.worktrees/api-hardening
   ```

   on branch `feat/api-hardening`. The worktree is already at HEAD commit `c93a1b3 docs(plan): adopt Option E — shared CF rate-limit namespaces with PAGE, kill Upstash` which sits on top of main's `65b82e4`. `pnpm install` has already been run — `node_modules` is ready. `pnpm cf:build` and `pnpm wrangler deploy --dry-run` have been verified healthy as the baseline.

   **Do NOT touch the main checkout at `/Users/user/dev/PROJECTS/AgentCommunity/AgentCommunity_DMV`** — that's for reference/observation only. All implementation edits go in the worktree.

2. **Two earlier commits on the feature branch** set up the plan:
   - `825e402 docs(plan): revise 2026-04-08 API hardening for Invisible Turnstile mode` — adapted Task 4/5 for Invisible Turnstile mode
   - `c93a1b3 docs(plan): adopt Option E — shared CF rate-limit namespaces with PAGE, kill Upstash` — the full Option E rewrite

   Both are plan-only commits. No worker/app code has changed yet. Your job is to execute Tasks 0–10 of the plan (in order), then stop. Task 11 is explicitly deferred.

3. **The Cloudflare Turnstile setup is done.** The user created an Invisible-mode widget in the dashboard on 2026-04-08 (Managed widget → Invisible, Pre-clearance: No). The public site key `0x4AAAAAAC2BwC5T9LSdndaK` is already inlined in the plan where Task 1 needs it. The secret key `TURNSTILE_SECRET_KEY` is already installed on the `dmv-agentcommunity` Worker via the Cloudflare dashboard — **do NOT try to install it with `wrangler secret put`**, there's a Worker version-mismatch guard that blocks secret edits and the dashboard install is the working path. The secret is available at runtime as `env.TURNSTILE_SECRET_KEY` but will NOT appear in `wrangler deploy --dry-run` output (dry-run never shows secrets).

4. **Required reading before writing any code** (in this exact order):

   a. `CLAUDE.md` in the worktree — project overview and hard constraints
   b. `CLOUDFLARE.md` in the worktree — existing Worker topology
   c. `docs/plans/archive/2026-04-07-cf-native-hardening.md` — the previous plan this builds on, especially Task 5 (Workers Rate Limiting) and Task 6 (KV badge cache)
   d. The plan itself at `docs/plans/2026-04-08-dmv-api-hardening-plan.md` — read it cover to cover, not just Task 0
   e. `worker/index.ts` — skim for the existing handlers (`handleBadge`, `handleCard`, `emitAnalytics`, `PERMALINK_CSP`, `SUPABASE_FUNCTIONS_ORIGIN`, the main `fetch` dispatch). As of commit `65b82e4` this is ~1200 lines.
   f. `supabase/functions/register-agent/index.ts` — the 363-line Deno edge function that Task 3 deletes the Upstash layer from

5. **You do NOT need to read the sibling repo `agentCommunity_PAGE`.** The plan has the full contents of the three files DMV is vendoring (`worker/rate-limit-cf.ts`, `worker/rate-limit-kv.ts`, `worker/normalize-email.ts`) inlined in Task 0 — copy them verbatim. The plan also has the exact namespace IDs (`4001`, `4005`, `4006`, `4007`) and KV namespace id (`c0e0d88fff1a4c59805ab85c7a03100f`) inlined where Task 1 needs them. If you want to cross-check by reading PAGE's `wrangler.jsonc` at `/Users/user/dev/PROJECTS/AgentCommunity/agentCommunity_PAGE/wrangler.jsonc` lines 30–55, go ahead — that's belt-and-suspenders, not required.

## How to execute

Use the **superpowers:subagent-driven-development** workflow (the same one that landed the previous plan successfully):

1. Start with **superpowers:using-superpowers** to set up skill context (this is automatic at session start).
2. The worktree and branch already exist — **skip the `using-git-worktrees` skill's create step**. Just `cd` into the worktree directly and verify with `git branch --show-current` (should print `feat/api-hardening`) and `git log --oneline -5` (should show `c93a1b3` at the top).
3. Then **superpowers:subagent-driven-development** to dispatch the plan task-by-task.

For each task in the plan (Task 0 through Task 10, in order):

- **Read the actual current state of every file the task touches before dispatching.** The plan was written carefully but code can drift between writing and execution. Grep for the exact symbols the plan references and note any discrepancies in the dispatch briefing.
- Dispatch a fresh implementer subagent with the **FULL inline task text** (don't make the subagent read the plan file — the previous-plan controller learned that lesson). Include any drift warnings you found during your pre-read.
- After implementation, dispatch a **spec compliance reviewer** subagent that cross-checks the implementation against the plan's task spec.
- After spec passes, dispatch a **code quality reviewer** via `superpowers:code-reviewer`.
- If either reviewer finds Important issues, dispatch a fix back to the implementer subagent and re-review.
- Mark the task complete (the plan uses `- [ ]` checkbox syntax — update them as you land commits) and move to the next.

After all ten tasks land, do a **final cross-task code review** via `superpowers:requesting-code-review` before deploy.

## Things the previous plan's execution taught us — apply proactively

- **Plan text can drift from current code as you progress** because earlier tasks mutate the files later tasks reference. When dispatching each task, READ the current state first and brief the implementer on the gap between the plan's wording and the real code. Catch drift preemptively.
- **The reviewer skill catches real bugs.** Don't skip reviews even when a task looks trivial. The previous plan had a Critical bug in the Task 6 plan text itself — a KV put was a fire-and-forget IIFE without `ctx.waitUntil`, which the runtime could cancel. The reviewer caught it before deploy.
- **Use the `browse` skill (gstack) for browser verification.** Task 4 updates the CSP to add Turnstile origins. After local deploy, use the browse skill to load `http://localhost:<port>/` in headless Chrome and check the DevTools console for CSP violations. Any violation → fix the directive and re-verify before committing.
- **Wrangler 4.80.0 is installed.** No syntax surprises expected. The worktree already has `@cloudflare/workers-types`, `@cloudflare/containers`, `typescript`, and `wrangler` as dev deps.
- **`pnpm wrangler secret put` is blocked** on the `dmv-agentcommunity` Worker due to a version-mismatch guard. The plan documents three install paths; use the Cloudflare dashboard for any secret changes during execution. The user already installed `TURNSTILE_SECRET_KEY` via dashboard on 2026-04-08.
- **Local Turnstile testing uses test site keys** (`1x00000000000000000000AA` always-pass / `2x00000000000000000000AB` always-fail). Plan Task 5 Step 4 walks through the full swap. **REMEMBER to revert to the real site key `0x4AAAAAAC2BwC5T9LSdndaK` in all three places (wrangler.jsonc, index.html meta tag, dashboard secret) before committing or deploying.** Grep for `1x000...AA` and `2x000...AB` before every commit in Task 5.
- **Cron prewarm is hourly.** No change needed for this plan.
- **Deploy bumps `CONTAINER_INSTANCE_ID` only if `container/server.mjs` or `container/src/*` changes.** This plan does NOT touch the container — if deploy bumps the instance ID, something leaked and should be investigated.
- **Smoke test convention:** the project has no automated worker tests by design. Smoke tests are `pnpm cf:dev` background + curl probes + `wrangler tail` for a few minutes. Each task in the plan has explicit smoke commands to run; follow them.

## Critical do-nots

- **Do NOT run Task 11 (Supabase bypass closure)** as part of this execution. The plan says "DO NOT RUN until 2+ weeks after Task 9 deploys AND <5% direct-Supabase traffic is observed." Task 9 publishes the new CLI; Task 11 closes the legacy direct-Supabase path that older CLIs still use. Running Task 11 prematurely breaks deployed CLI users in the wild. Confirm the deferral with the user if you think you're ready for it.
- **Do NOT reintroduce `env.API_RATE_LIMITER`.** Task 0 renames it to `env.RL_CARDS`. Every subsequent task should use the new name.
- **Do NOT invent new namespace IDs for the shared CF Rate Limiting bindings.** The four shared bindings MUST use the exact numeric values `4001`, `4005`, `4006`, `4007`. These match PAGE's `wrangler.jsonc` at `/Users/user/dev/PROJECTS/AgentCommunity/agentCommunity_PAGE/wrangler.jsonc` lines 31-37. If you verify and find PAGE's values have drifted, STOP and ask the user before proceeding — drift here breaks the Option E alignment that's the whole point of this plan.
- **Do NOT invent the key prefix for shared-namespace keys.** The plan mandates the `otp:*` prefix (`otp:email:<hash>`, `otp:ip:<hash>`, `otp:ip-email:<hash>`) even though DMV does registration, not OTP. The prefix is what lands in the shared counter bucket; changing it silently splits the keyspace and destroys the sharing benefit. See Task 2 Step 4 and the self-review section.
- **Do NOT add any new npm dependencies** to the worker or the browser. The `@modelcontextprotocol/sdk` + `@cloudflare/*` + `typescript` + `wrangler` setup is all that's allowed.
- **Do NOT touch the container** (`container/Dockerfile`, `container/server.mjs`, `container/src/*`). This plan's rate-limit changes are worker-only. If you find yourself editing container files, you've gone out of scope.
- **Do NOT touch `js/qr-encode.js` or `container/src/qr-encode.js`** — the drift-check in `scripts/build-cf.mjs` hard-fails builds if they drift, and this plan doesn't need QR changes.

## What to verify is currently true (sanity check before you start)

Run these and confirm the output matches:

```bash
cd /Users/user/dev/PROJECTS/AgentCommunity/AgentCommunity_DMV/.worktrees/api-hardening
git branch --show-current           # → feat/api-hardening
git log --oneline -3                 # → top commit c93a1b3 (plan Option E)
git status --short                   # → should be empty (clean tree)
pnpm wrangler --version              # → 4.80.0 or higher
curl -s https://dmv.agentcommunity.org/healthz | python3 -m json.tool
# Expected: { "worker": "ok", "container": { "status": "ok", ... } }
```

If any of these are off, STOP and ask the user before proceeding.

## Reporting

When you complete each task, report:
- The commit hash
- A one-line summary of what landed
- Any drift or surprises you caught during the pre-read
- The output of the task's smoke test commands (don't paraphrase — paste the relevant curl outputs / dry-run tails)

When you finish all tasks (or get blocked on something the user needs to do), give a final summary in this format:

```
## Final state

| Task | Status | Commit | Notes |
|---|---|---|---|
| Task 0 | ✓ | abc1234 | Vendored shims + rename, card-path smoke green |
| Task 1 | ✓ | def5678 | 13 bindings verified in dry-run |
| ...   |   |         |       |

## Smoke test results
- /api/register (prod): ...
- /api/card rate limit (prod): ...
- CLI bunx smoke: ...

## Deferred
- Task 11 (Supabase bypass closure) — deferred per plan, revisit 2026-04-22+
```

Ready when you are. Start by reading CLAUDE.md + CLOUDFLARE.md + the plan file (which is 2300 lines — read it in chunks if needed), then sanity-check the worktree state, then dispatch Task 0.

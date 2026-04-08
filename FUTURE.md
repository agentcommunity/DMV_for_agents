# Future Work

Items noted for later — not blocking go-live.

---

## ~~Badge URL Stability~~ — DONE

Badge URLs route through `dmv.agentcommunity.org/badge/...` instead of exposing the raw Supabase project URL. Post-CF cutover, the proxy lives in `worker/index.ts` (`handleBadge`) with header hygiene + path-traversal defense. The `register-agent` edge function returns clean URLs in its 201 response. All doc embed examples updated.

If the Supabase backend changes, update `SUPABASE_FUNCTIONS_ORIGIN` in `worker/index.ts` — zero breakage for users.

---

## ~~API Hardening~~ — DONE (2026-04-08)

Browser, CLI, and MCP registration all converge on the worker `/api/register` endpoint now. The worker owns Turnstile (browser path), shared CF rate limits with `agentCommunity_PAGE` (`RL_OTP_EMAIL` 5/60s, `RL_OTP_IP_EMAIL` 4/60s — both `namespace_id` values shared at the CF account level), and a DMV-local KV fingerprint cooldown (`REGISTER_COOLDOWN_KV`) for headless clients. Upstash Redis was removed from `register-agent` entirely. CAPTCHA always runs before shared counters so invalid tokens cannot exhaust quota for real users.

Design walked back from the original Option E plan (which over-coupled DMV to PAGE) per `docs/plans/2026-04-08-cross-repo-hardening-handoff-prompt.md`. The handoff prompt is the source of truth for all coupling decisions.

**Still open:** closing the direct-Supabase bypass for legacy CLI versions. `register-agent` currently still accepts direct calls; gating it on an `x-dmv-proxy: v1` header set by the worker is tracked under "Known gaps" in `CLOUDFLARE.md`. Schedule depends on adoption of the new `@agentcommunity/dmv-agent` CLI version.

---

## Other Items

- [ ] **Link/visit tracking** — Track permalink visits (`/c/CERT-ID/agent-name`) for sharing virality metrics
- [ ] **Google/GitHub OAuth** — Alternative to magic link verification
- [x] **Dynamic OG images** — Server-rendered per-card OG images via the Cloudflare Container + `@napi-rs/canvas` (same Skia renderer as `/api/card`, composited onto a 1200×630 canvas by `container/server.mjs`)
- [ ] **3D card OG capture** — Upgrade OG images to use client-side Three.js canvas capture of the actual holographic card. Capture after card generation → upload PNG to Supabase Storage → serve as OG image. Plan in `.claude/plans/cosmic-gathering-yao.md`
- [ ] **Python SDK** — Thin wrapper for cross-language support
- [ ] **Admin dashboard** — View registrations, manage verifications, handle disputes
- [ ] **Inline certificate cards** — Show cards on agentcommunity.org members dashboard domains section
- [ ] **Individual endorsements** — Different DocuSeal link than org
- [ ] **Fold DMV into monorepo** — If shared components emerge with agentcommunity.org
- [ ] **Dynamic sitemap.xml** — Generate from registered agent permalinks. Requires edge function or build-time DB query to enumerate `/c/CERT-ID/agent-name` URLs
- [ ] **JSON-LD structured data** — `Organization` + `WebApplication` on homepage, per-agent `Person`/`SoftwareApplication` markup on permalink pages

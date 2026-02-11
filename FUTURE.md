# Future Work

Items noted for later — not blocking go-live.

---

## ~~Badge URL Stability~~ — DONE

Vercel rewrite added in `vercel.json`. Badge URLs now route through `dmv.agentcommunity.org/badge?id=...` instead of exposing the raw Supabase project URL. The `register-agent` edge function returns clean URLs in its 201 response. All doc embed examples updated.

If the Supabase backend changes, update the rewrite destination in `vercel.json` — zero breakage for users.

---

## Other Items

- [ ] **Link/visit tracking** — Track permalink visits (`/c/CERT-ID/agent-name`) for sharing virality metrics
- [ ] **Google/GitHub OAuth** — Alternative to magic link verification
- [x] **Dynamic OG images** — Server-rendered per-card OG images via `@vercel/og` (see below)
- [ ] **3D card OG capture** — Upgrade OG images to use client-side Three.js canvas capture of the actual holographic card. Capture after card generation → upload PNG to Supabase Storage → serve as OG image. Plan in `.claude/plans/cosmic-gathering-yao.md`
- [ ] **Python SDK** — Thin wrapper for cross-language support
- [ ] **Admin dashboard** — View registrations, manage verifications, handle disputes
- [ ] **Inline certificate cards** — Show cards on agentcommunity.org members dashboard domains section
- [ ] **Individual endorsements** — Different DocuSeal link than org
- [ ] **Fold DMV into monorepo** — If shared components emerge with agentcommunity.org

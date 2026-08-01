# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Running the Project

```bash
uv run python -m http.server 8080
# open http://localhost:8080
```

No build system for the SPA. Native ES modules via browser importmap. Serve from project root.

## Deployment

Cloudflare Workers Static Assets + a Cloudflare Container (Node 20 + `@napi-rs/canvas` Skia) for card rendering. Worker `dmv-agentcommunity` on Taqanu account, container instance type `lite`. The Cloudflare Git integration's automatic build from merged `main` is the single authoritative production deploy path. Observe that build; use `pnpm cf:deploy` only after confirming that an automatic build is neither active nor already started, and never run both paths concurrently. Local dev: `pnpm cf:dev`. Architecture, cache hierarchy, and drift invariants: [CLOUDFLARE.md](CLOUDFLARE.md). Broader migration history + container rename gotcha: `docs/admin/CLOUDFLARE-MIGRATION.md` in the `agentcommunity_page` repo.

## Architecture

Pre-registration system for `.agent` domain identities. Two interfaces, one backend:

1. **Web CRT terminal** — 3D retro TV with interactive form (for humans & organizations)
2. **CLI CRT terminal** — ASCII art terminal in the shell (for AI agents, operator required)

All flows are **pre-registration** (not registration). Pre-registration records interest in a `.agent` domain. It does not guarantee assignment.

**Web data flow:** Scroll (or tap-the-monitor on landing — 3s GSAP `scrollTop` tween) drives camera zoom → CRT boots at 60% progress → type selector (org/individual) → conditional form fields with validation → review/submit (TnC + Charter links, submit button) → invisible Turnstile widget executes → POST to same-origin `/api/register` worker → worker verifies Turnstile (hostname + `dmv_register` action) → worker checks shared CF rate limits → worker forwards to Supabase → review state holds until response, then processing bar plays → `CRTTerminal.onComplete(formData)` fires with the authoritative cert ID → `HoloCard.show(formData)` draws holographic card with rarity-based shader effects → card bobs + tilts toward mouse/gyro → card is clickable to zoom. **Full navigation/exit contract: [NAVIGATION.md](NAVIGATION.md).**

**CLI source-target data flow (v3 ready, not deployed):** Boot screen (about/terms/charter menu) → step-by-step form (agent name → operator [required] → email → description) → confirmation summary → Y/n gate → POST to `/api/register` worker (with `signup_source: 'cli'` and `machine_fingerprint`) → worker checks shared CF rate limits → worker transactionally claims an exact `REGISTER_FINGERPRINT_LIMITER` slot → worker forwards to Supabase → a well-formed fresh mint commits, only audited pre-INSERT responses or an exact replay release, and every uncertain outcome stays pending → success screen: view card link (permalink to holographic card), share nudge (invite command + card URL), save card (direct PNG download URL), badge markdown snippet, email verification note. Production still uses the pre-v3 KV cooldown.

**Module graph:**
```
app.js ─┬─► TV.js ──► CRTTerminal.js   (TV owns CRT, uses its canvas as Three.js texture)
        ├─► Intro.js ──► volumetric-pass.js   (cinematic click-to-enter intro: god-ray lamp + music sync)
        ├─► HoloCard.js ──► card-draw.js ──► qr-encode.js
        ├─► WallSign.js                (wall sign above TV, fluorescent flicker animation)
        └─► AboutPoster.js             (about panel)
```

- `app.js` — Entry point. Wires TV + HoloCard + AboutPoster, events (scroll, click, keyboard, resize, gyro), sound toggle, clock, permalink routing. Top-level await, no exports.
- `TV.js` — Three.js scene: GLTF model loading (Draco), camera, renderer, night mode toggle, raycaster, card/about zoom/unzoom, `onRender(cb)` callbacks, render loop with delta time.
- `CRTTerminal.js` — Pure Canvas2D, no Three.js dependency. 8-phase boot state machine (off, flicker, boot text, type selector, form, review/submit, processing, done), conditional form fields with validation, color scheme swapping, CRT visual effects.
- `HoloCard.js` — Self-contained holographic card module. Custom ShaderMaterial (GLSL) with rainbow iridescence, foil lines, glare, fresnel, sparkle. Front + back faces with Canvas2D content. Rarity system, identicon, scannable QR code (real encoder). Bob + tilt animation. See [CARD.md](CARD.md).
- `WallSign.js` — Wall sign above the TV. PlaneGeometry + CanvasTexture with "DEPT. OF MACHINE VERIFICATION" title and "SELF-SERVE KIOSK" subtitle. Fluorescent tube flicker-on animation (GSAP timeline) fires ~1.2s after page load (not scroll-linked). Ambient flicker loop (random subtle opacity dips every 4-7s) runs after startup. Theme-aware via CSS custom properties. Self-contained with `dispose()` cleanup.
- `AboutPoster.js` — PlaneGeometry + CanvasTexture. UI-style about text, toggle show/hide.
- `Intro.js` / `volumetric-pass.js` — Cinematic "video mode" intro: a **click-to-enter** gate (one tap starts intro + music together, so audio is in sync in every browser incl. Safari), a real shadow-aware **volumetric god-ray "lamp"** that arcs behind→over→front (silhouette → beams → front-lit reveal), the fade-to-black handoff to the normal scene, and **music synced so the track's drop lands on the reveal**. Tunable via `?tune` (`js/intro-control-panel.js`, DEV-TUNE-gated). See [INTRO.md](INTRO.md).

**External deps (all CDN, no npm):**
- Three.js 0.152.2 via importmap
- GSAP 3.12.2 + ScrollTrigger via `<script>` tags (accessed as `window.gsap` in modules)
- Draco decoder from Three.js CDN

## Agent-Facing Content

Multiple surfaces carry agent-onboarding content (register → share → AID → contribute). When editing one, keep the others consistent:

- **SKILL.md** (`packages/dmv-agent/skills/dmv/SKILL.md`) — richest version, the "welcome packet". 7 sections including AID setup guide.
- **llms.txt** — medium richness, linked from `<link rel="alternate">` in index.html. Includes registration, sharing, AID, contribute.
- **README.md** (`packages/dmv-agent/README.md`) — "For AI agents" section with quick AID hint.
- **Hidden HTML** (`index.html`, `<div hidden data-agent-info>`) — lightest distillation for agents parsing page source.
- **Meta tags** (`index.html`, `<meta name="agent:*">`) — CLI command + MCP config for agent tooling discovery.

CLI-first everywhere. MCP is available but secondary — `bunx @agentcommunity/dmv-agent register` over MCP config.

## Critical Constraints

- **CRT texture mapping params must not change:** `repeat(1.7, 1.7)`, `offset(-0.64, -0.42)`, `flipY: false` in TV.js. These map the CRT canvas onto the TV screen mesh.
- **GSAP is a global**, not an import. Always access via `window.gsap` / `window.ScrollTrigger`.
- **CSS base font-size is 62.5%** so `1rem = 10px`. All rem values are 10x what you'd expect (e.g., `2.4rem` = 24px).
- **Color schemes are swapped in-place.** `setColorScheme()` remaps existing line color strings. If you add new hardcoded color values in CRTTerminal, add them to the remap logic too.
- **`flickerRGB`** is an `"R, G, B"` string used in template literal `rgba()` calls throughout CRTTerminal. All glow/scanline/noise effects use it — don't replace with hex.
- **Cache busting:** All imports use `?v=N` query params. Bump in app.js imports, TV.js import, AND index.html script tag together.

## Night Mode

Toggled by clicking the TV button (raycaster hit on invisible trigger box). Swaps:

| Property | Day | Night |
|----------|-----|-------|
| CRT palette | green (`#33ff88`) | orange (`#ffaa33`) |
| TV button color | `0x33ff88` | `0xcc6622` |
| Tone mapping exposure | 3.0 | 0.6 |
| Fog/clear color | `0x7a7a7a` | `0x454546` |

HoloCard shader is tone-mapped, so it dims in night mode but holo effects still show through.

## Permalink System

Path format: `/c/CERT-ID/agent-name`.

In permalink mode:
- TV GLB is **not** loaded (`tv.init({ skipModel: true })`); model lazy-loads on first unzoom
- Card shown instantly, camera jumps to it (`tv.jumpToCard()`)
- Header "About" swapped to green "Get Yours" CTA
- Bottom overlay: "Get Yours" + "Share on X" + "Save Card" buttons with backdrop blur
- `#sceneExit` corner pill labeled "HOME" — navigates to `/`
- Escape or clicking the DOM card also navigates to `/` (via `dismissCard()`)
- Clicking empty world unzooms in-place and triggers lazy-load
- Footer hidden to avoid overlap with overlay

See [NAVIGATION.md](NAVIGATION.md) for the full state machine.

## Navigation & Movement

The scene has one driving axis (scroll progress) and four "deep" UI states (Card zoom, About zoom, Agent View, CRT reading mode). The corner `#sceneExit` pill is the single universal exit for every deep state — it shows a context-aware label (`CLOSE` / `BACK` / `TOP` / `HOME`) and dispatches via `exitCurrentZoomState()`. Card unzoom is always `dismissCard()` (consolidates 3 previously-divergent paths and handles permalink-mode routing). Landing has both scroll and tap-the-monitor as entry affordances (the latter runs a 3.0s GSAP `scrollTop` tween so the CRT boot sequence plays out cinematically).

**Full reference (every state, input, exit path, helper function, design rationale): [NAVIGATION.md](NAVIGATION.md).** Edit it when you touch any input handler, zoom state, or visibility logic.

## QR Code Encoder

`js/qr-encode.js` is a minimal, zero-dependency QR encoder (byte mode, ECL L, versions 1-6, Reed-Solomon over GF(2^8), 8 mask patterns with penalty scoring). It exports `generateQRMatrix(text)` → `{ matrix: boolean[][], size: number }`.

- **Browser**: HoloCard.js imports `generateQRMatrix` and injects it into card-draw.js via `setQREncoder()` at module load time. card-draw.js has no direct import — the encoder is injected to avoid side effects.
- **Server**: `container/src/card-renderer.js` imports `generateQRMatrix` directly from `container/src/qr-encode.js`, which is a byte-identical copy of `js/qr-encode.js`.
- **QR content**: Encodes the full permalink URL `{baseUrl}/c/{certId}/{name}`. Label on card: "SCAN".
- **Barcodes**: Remain Code 128B encoding cert ID text and domain name (not URLs — URLs are too long for readable barcode bars at current dimensions).

When changing the QR encoder, update both `js/qr-encode.js` and `container/src/qr-encode.js` together. `scripts/build-cf.mjs` hard-fails the build if they drift, so `pnpm cf:dev`/`pnpm cf:deploy` will refuse to run until they match.

## Card Download

"Save Card" buttons appear in two places:
- `#cardShareBar` — the floating bar shown when the card is zoomed (post-registration or `?demo` mode)
- `#permalinkOverlay` — the overlay on permalink pages

Both call `downloadCard()` in app.js which uses `canvas.toBlob()` → hidden anchor click → downloads as `{name}.agent-card.png`.

## OG Image Strategy

Both social preview endpoints hit the **same** Cloudflare Container running `@napi-rs/canvas` (Skia). The Vercel-era dual-stack (Canvas for og:image, Satori for twitter:image) is gone — there's no cold-start race to design around anymore because the Worker serves 99%+ of requests from L1 `caches.default` or R2 without ever waking the container.

- **`/api/card`** — 880×630 card PNG. Full renderer output, used for `/api/card?...` direct downloads and as the canonical card.
- **`/api/og`** — Same renderer, same card, composited centered on a 1200×630 dark canvas by `container/server.mjs`. Used for both `og:image` AND `twitter:image`.

`/c/CERT-ID/name` crawler injection lives in `worker/index.ts` `handlePermalink` — HTMLRewriter streams `index.html` and overrides `og:*` / `twitter:*` meta tags per permalink. Both meta groups point at `/api/og` now (no need for the old split).

## Key Patterns

- **Adding 3D objects:** Get scene via `tv.getScene()`, add meshes. HoloCard demonstrates the pattern.
- **Frame-synced updates:** Use `tv.onRender(cb)` to get delta-time callbacks in the render loop.
- **Adding CRT form fields:** Edit the field sets in `CRTTerminal.selectAccountType()`.
- **New color schemes:** Add to `CRTTerminal.palettes`, call `setColorScheme('name')`.
- **Scroll-triggered events:** Add thresholds in `TV.animateCameraPosition(progress)` or use `tv.on('animationEnd', cb)`.
- **Zoom transitions:** When transitioning between zoomed states (card → about), unzoom first with a delay, then zoom to new target. The card→about handoff is 860ms (`openAbout()` in app.js).
- **Universal exit:** Don't add new close buttons per state — route through `exitCurrentZoomState()` so `#sceneExit` knows about your new state. Add to `syncSceneExit()` visibility logic and the dispatcher both. See [NAVIGATION.md](NAVIGATION.md).
- **Card unzoom:** Always go through `dismissCard()` — never call `tv.zoomOutFromCard()` directly. `dismissCard()` handles permalink-mode routing and DOM card hiding.
- **Wall sign tuning:** Flicker timing lives in `WallSign.flickerOn()` (GSAP timeline keyframes). Ambient flicker interval is in `_startAmbientFlicker()` (4-7s range, opacity dip to 0.92). Startup delay is the `setTimeout` in app.js (~1.2s). Sign position is `mesh.position.set(0, 3.0, -0.5)`.
- **Demo mode (`?demo`):** Cycles cards with Space bar. Sets `latestCardData` so share/copy/save buttons work. No CRT form needed.

## Static Assets

`fonts/` has 4 PPSupply font files (.otf). `models/` has `tv1.glb` (Draco GLTF).

## Backend & NPM Package

See [ARCHITECTURE.md](ARCHITECTURE.md) for the full system map.

**Worker `/api/register` source contract** (`worker/index.ts` `handleRegister`): canonical registration entry point for browser, CLI, MCP, and JS API traffic. This branch owns anti-abuse through Turnstile on the browser path, shared Cloudflare rate limiters (`RL_OTP_EMAIL` namespace `4005`, `RL_OTP_IP_EMAIL` namespace `4007`), and an exact `REGISTER_FINGERPRINT_LIMITER` SQLite Durable Object budget on the CLI/MCP path. One object per SHA-256 fingerprint hash transactionally reserves capacity before upstream. A well-formed fresh `201` commits; only audited, well-formed pre-INSERT `400`/`403`/`409` responses and exact `200 already_recorded` replays release. Every 5xx/546, malformed/unexpected response, body-read failure, timeout/abort, and transport failure stays pending. The 45-second local response deadline does not claim to stop the remote function. Abandoned claims remain pending for 600 seconds (150-second Supabase request-idle timeout + 400-second Edge Function wall clock + 50-second margin), then count for a full 24 hours. CAPTCHA runs before shared counters; `DMV_PROXY_SECRET` presence is checked before any quota. The secret-gated Supabase upstream rejects direct access with 403 `direct_access_deprecated`. Production remains on the pre-v3 KV registration path until this branch is deployed and verified.

**Worker `/api/lookup`** (`worker/certificate-lookup.ts`): live as of 2026-07-22 on merged `main` `fabafe6` (PR #20) and Worker version `d9755e66-3883-4970-be84-a59307011f14` created `2026-07-22T12:01:52.501Z`. It is the only public certificate lookup: `GET ?id=CERT-ID`; domain enumeration is removed. It validates the check digit before quota, applies coarse/eventually consistent `RL_CERT_LOOKUP` at 60/60, then uses one `CERT_LOOKUP_LIMITER` SQLite Durable Object per hashed IP for exact transactional 30/60 accounting and headers. Pre-DO responses omit guessed exact remaining/reset values. Durable Object failure fails closed before reading `BADGE_CACHE_KV` (300s issued, 60s typed not found). Public responses are `private, no-store` and contain only `certificate_id`, `status`, `valid_format`, `issued`, `agent_name`, and `certificate_url`. `issued: true` means the registration row exists; it does not mean email verification, name allocation, or DNS delegation completed.

**Edge functions** (`supabase/functions/`): `register-agent` and `lookup-agent` are live internal Worker upstreams authenticated by `DMV_PROXY_SECRET`; direct Supabase calls return `403 direct_access_deprecated`. `lookup-agent` is deployed `--no-verify-jwt`, accepts certificate IDs only, and returns exactly a typed HTTP 200 `issued` or `not_found` envelope; every other Worker-observed response is unavailable and uncached. `badge` remains behind the Worker's public `/badge/*` proxy. All are Deno. Zero secrets in client code.

**Lookup rollout record and recovery:** the Worker-first deployment, secret-gated Edge deployment, and final smokes completed 2026-07-22. Evidence: issued `REEF-068-BD0Q` returned `200` for `masato`; generated absent `ZZZZ-FFF-FFFD` returned `200 not_found`; `INVALID` returned `400`; calls 1–30 passed, 31 returned `429`, and a next-minute call returned `200` with remaining `29`; health, card, badge, permalink, and validation-only registration checks passed. Cloudflare's runtime requires `redirect: 'manual'`, not `error`; retain manual redirects while treating every 3xx as fail-closed and never following a redirect with the secret. Current production recovery must preserve deployed v1/v2. After the source-ready v3 registration limiter deploys, preserve v1/v2/v3 and all three exports/bindings together. Never publish the secret or document a direct Edge URL as a client API. See `packages/dmv-agent/DEPLOY.md` for recovery steps.

**Trigger chain**: register-agent INSERTs with `certificate_id` set + `user_id: NULL`. The `status` column is intentionally NOT set — it uses the DB default (`pending_profile`). PAGE's DMV integration (migrations `20260210999999` + `20260211000000` + `20260211000100` in the agentCommunity_PAGE repo) identifies DMV rows by `WHERE certificate_id IS NOT NULL`, not by any status value. A database trigger (`on_dmv_registration`, fires on `certificate_id IS NOT NULL`) on the agentcommunity.org side fires asynchronously (pg_net), creates/finds auth user, sends the certificate email (and, for new users, a clickable **magic-link verify email** pointed at `agentcommunity.org/api/auth/magiclink/verify` — not a 6-digit code), and manages the `user_domains` table. DMV's own edge function does NOT create auth users or send emails. See [AUTH_DMV.md](AUTH_DMV.md) for the full auth integration flow.

**Pre-registration model**: Multiple users can register interest in the same `.agent` domain. `domain_requested` is NOT unique. `certificate_id` is unique (same user+agent+type = same cert ID). Badge lookup is by cert ID only (`?domain=` deprecated).

**NPM package** (`packages/dmv-agent/`): Published canonically as `@agentcommunity/dmv-agent` on npm; `dmv-agent` is an unscoped compatibility alias in `packages/dmv-agent-alias/`, not a second capability. CLI, MCP server, JS API, Claude Code `/dmv` skill. TypeScript, pnpm for dev, `bunx @agentcommunity/dmv-agent` for users. Only runtime dep: `@modelcontextprotocol/sdk`. CLI sends `signup_source: 'cli'`, MCP sends `'mcp'`.

**CLI architecture** (`packages/dmv-agent/src/`):
- `cli.ts` — Main CLI: boot screen, form flow, submit, content pages (about/terms/charter)
- `ui.ts` — CRT frame renderer: ASCII art, ANSI green/amber/red colors, box drawing, progress bar. Zero dependencies.
- `rate-limit.ts` — Machine fingerprint (SHA-256 of hostname+user+platform) + local lockfile (`~/.dmv-agent/registrations.json`, 3/machine/24h). Advisory client-side check; the source-ready v3 Worker enforces the exact budget via `REGISTER_FINGERPRINT_LIMITER` after deployment.
- `register.ts` — Worker proxy client, POSTs to `https://dmv.agentcommunity.org/api/register` with `signup_source` (`cli`/`mcp`) and `machine_fingerprint`. The CLI never talks to Supabase directly anymore.

**Go-live checklist**: `packages/dmv-agent/DEPLOY.md`

## Branding

- DMV = Department of Machine Verification
- Part of the [.agent community](https://agentcommunity.org) — ICANN application for `.agent` gTLD
- Header: "DMV for agents"
- Terminal subtitle: "Machine Identity & Pre-Registration Terminal v1.0" (web) / same in CLI
- All copy says "pre-registration" — never just "registration"
- Sound toggle wired to `audio/pat102 - electro dance.mp3` (the only file in `audio/`)

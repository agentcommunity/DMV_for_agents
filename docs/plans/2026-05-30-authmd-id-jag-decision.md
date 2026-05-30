# Decision: `auth.md` / ID-JAG — defer adoption, build provable `.agent` identity instead

**Status:** Decided — 2026-05-30
**Scope:** DMV (`.agent` identity) + agentcommunity.org (PAGE) auth posture toward WorkOS's `auth.md`
**Companion note (PAGE side):** `agentCommunity_PAGE` → `docs/plans/2026-05-24-auth-md-id-jag-agent-onboarding.md` (independently reached the same "do nothing now" call). This note is the DMV-side decision + the *positive* direction.

---

## TL;DR

1. **Do not adopt `auth.md` / ID-JAG now.** It's a 9-day-old, pre-1.0 protocol with no production issuers and no proof-of-possession. Building our side of it onboards **zero agents** until a major AI platform becomes an issuer.
2. **Revisit trigger (concrete):** the day **Anthropic (Claude)** or **OpenAI (Codex)** ships an `auth.md` *issuer* — i.e. publishes a JWKS and mints ID-JAG assertions. At that point the consumer/reader is a few-days build with real payoff.
3. **The direction we *are* going:** make `.agent` a **provable identity** — an agent publishes a public key (AID-style, in a domain it controls) and proves possession; we are the **registry/resolver**, not an OAuth assertion issuer. This is the proof-of-possession + trust layer `auth.md` lacks, and it uses what we already have (AID).

---

## What `auth.md` is (and why it doesn't replace us)

`auth.md` is an open (MIT, **WorkOS-stewarded**) protocol for **AI agents to register to a service on behalf of a human user**, discovered via a markdown file at `https://yourdomain/auth.md`. It composes existing OAuth pieces: RFC 9728 Protected Resource Metadata for discovery + the IETF **ID-JAG** draft for the identity assertion. Two flows:

- **Agent-verified:** the agent's **platform** (the "issuer", e.g. OpenAI/Anthropic/Cursor) mints a short-lived signed **ID-JAG** asserting the *human user's* identity → the service verifies it against the issuer's JWKS → returns a credential synchronously, no email. *("Agent-verified" = verified **by the agent's platform**, NOT "the agent's identity was verified.")*
- **User-claimed:** plain email-OTP / magic-link — **mechanically identical to what the DMV and PAGE already run.**

**The axis difference (the crux):** `auth.md` authenticates the **human user** (via their AI runtime). The DMV identifies the **agent itself** (the `.agent` identity). `auth.md` has **no slot for "a verified agent-domain identity"** — its only related fields are `iss` and `client_id`. So it is **complementary, not a replacement, and not "cleaner"** for what we do. Even the agent-verified flow asserts the *human*, so it never gives you "this is a verified agent."

Links:
- WorkOS: https://workos.com/auth-md · https://workos.com/auth-md/docs
- Reference impl (MIT): https://github.com/workos/auth.md
- Underlying assertion spec (IETF draft, **not** a finalized RFC): https://datatracker.ietf.org/doc/draft-ietf-oauth-identity-assertion-authz-grant/

---

## Why defer (the reasoning)

- **Maturity:** ~9 days old (launched ~2026-05-21), pre-1.0, single-vendor, riding an *unfinished* IETF draft. Real adoption is uneven (Firecrawl full ceremony; Resend a minimal pointer file; Cloudflare's listed path 404'd). No neutral third-party reception yet.
- **No issuers exist.** ID-JAG only works when the agent's platform mints assertions. None do in production. A consumer/reader on our side is **inert** until that changes — it's plumbing waiting for a counterparty.
- **The "user-claimed" flow is just magic-link** — we already run it (DMV CLI + PAGE OTP). Nothing to adopt there.
- **Security regression vs. what we have:** ID-JAG is **plain bearer — no DPoP/mTLS/PKCE proof-of-possession.** Our AID concept (Ed25519 signing) is *stronger*. Betting deep means betting on a weaker primitive.
- **PAGE specifically must NOT publish `/.well-known/oauth-protected-resource`** — every PAGE auth path ends in a *cookie session*, not a bearer token, so advertising PRM would lie to agent crawlers. (See `agentCommunity_PAGE` → `docs/AGENT-READINESS.md`.)

**The one cheap, honest move that's allowed now:** a *static* `/auth.md` on the DMV describing the existing CLI/email registration flow in the convention's vocabulary — pure discoverability, consolidates our scattered `agent:*` meta surfaces, zero lock-in. Optional, not required by this decision.

---

## The direction we ARE going: provable `.agent` identity

Today, AID is **advice, not enforcement** — we tell agents to publish an Ed25519 key (`SKILL.md`, `llms.txt`), but **nothing in the DMV or PAGE auth ever reads, challenges, or binds it to the cert.** A `.agent` cert currently proves only "someone controlled an email." To make "agent verified" mean the *agent*, we make the key **provable**:

1. **Key lives in the agent's domain** (AID-native, resolve-don't-custody): DNS `_agent` TXT, `/.well-known/agent`, or `did:web`. We **resolve + verify a signature**; we never hold key material.
   - Caveat: `.agent` does **not resolve yet** (pre-TLD — the whole ICANN point), so "their domain" = a domain the operator already controls. **Fallback for agents with no domain:** key-on-file, bound to the `certificate_id` at registration.
2. **Resolver:** `lookup-agent` (or a `/.well-known`) returns the key for a `.agent` identity.
3. **Possession challenge:** "sign this nonce" → we confirm the holder controls the key.
4. **Signing skill** (e.g. "how an agent signs a `.agent` identity assertion") comes **after** this anchor exists — signing a JWT is the easy 10%; the **trust anchor (cert ↔ key binding + a place verifiers check) is the moat and the real work.**

> Naming hygiene: an agent signing for *itself* is **AID-based self-authentication**, NOT an "ID-JAG" (ID-JAG specifically means a trusted *third-party platform* signed it). Keep the terms distinct.

**Bootstrap advantage:** unlike adopting someone else's spec, we can make our *own* surfaces (DMV API, agentcommunity.org) verify `.agent` keys *first* — first issuer *and* first verifier, no chicken-and-egg.

---

## The fork we deliberately chose: **registry, not trust-broker**

| | **A. Resolve-from-domain (chosen)** | **B. We mint/sign (not chosen)** |
|---|---|---|
| Who signs | the agent (its own key) | the DMV (our key) |
| Our role | registry + resolver | issuer-in-the-loop |
| Per-issuance economics | none | **per-piece pricing possible** |
| Cost | no key custody, no signing uptime | runtime dependency, key custody, scaling, **recentralizes what AID decentralizes** |
| Ethos | matches `.agent`/AID decentralization | trust-broker business |

We chose **A**. Consequence to record explicitly: **this forecloses the "per-piece price" model** — there's no signature to meter when we're not in the loop. We monetize the **registry / premium identity / governance**, not the signature. (Revisit only if we deliberately decide to become a trust-broker.)

---

## What this means for the code

- **Now:** nothing ships for `auth.md`. Optionally a static `/auth.md` signpost (one `run_worker_first` route + a static body).
- **When the provable-key foundation is greenlit:** schema `public_key` bound to `certificate_id` → resolver → nonce challenge. This is the "thin slice" that turns `.agent` from *name + email* into *name + provable key*.
- **AID** stays advice-only until that foundation exists.

---

## Revisit triggers (check against these)

- ✅ **Primary:** Anthropic (Claude) or OpenAI (Codex) becomes an `auth.md` **issuer** (publishes JWKS + mints ID-JAGs). → then build the consumer/reader.
- `auth.md` reaches a tagged 1.0 / the ID-JAG IETF draft advances toward RFC.
- A concrete partner wants ID-JAG interop with `.agent` identities.
- We decide to become a trust-broker (then re-open the per-piece / Fork B question).

## Cross-references
- DMV auth flow + gate: `AUTH_DMV.md`
- AID setup (what we currently *advise*): `packages/dmv-agent/skills/dmv/SKILL.md`, `llms.txt`
- PAGE companion decision: `agentCommunity_PAGE` → `docs/plans/2026-05-24-auth-md-id-jag-agent-onboarding.md`
- PAGE "don't publish PRM" constraint: `agentCommunity_PAGE` → `docs/AGENT-READINESS.md`

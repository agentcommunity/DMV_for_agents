# Changelog

All notable changes to `@agentcommunity/dmv-agent` are documented here.
Format loosely follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## 0.3.0

### Changed — `verify_certificate` (MCP) / `dmv-agent verify` (CLI) now check live issuance by default

**Why:** The main `agentcommunity.org` site exposes an MCP tool also named
`verify_certificate` that checks live issuance via the DMV Worker. This
package's tool of the same name only checked the Luhn mod-36 check digit —
an agent with both MCP servers configured could get contradictory answers
("valid" vs. "not issued") for the same certificate ID. Fixed by wiring this
package's tool to the same live lookup the main site uses.

- `verify_certificate` (MCP) and `dmv-agent verify` (CLI) now call
  `GET https://dmv.agentcommunity.org/api/lookup?id=<id>` by default — the
  same public, rate-limited (~30/60s per IP) endpoint the main site's tool
  uses. A result of `issued: true` means a matching registration row exists;
  it does **not** mean the operator completed email verification or that DNS
  delegation exists.
- Added a `format_only: true` argument (MCP) / `--format-only` flag (CLI) to
  skip the network call and only validate the offline Luhn check digit —
  this is the full extent of what the tool checked before this release.
- Network errors, timeouts, unexpected HTTP statuses, and malformed, partial,
  extra-field, mismatched-ID, or otherwise inconsistent JSON **automatically
  fall back** to offline check-digit validation. An exact typed HTTP 503
  `unavailable` envelope remains a live inconclusive result; it does not fall
  back. The response text always states plainly which check
  actually ran (`(live check)` vs. `(format-only ...)`) — a network failure
  is never reported as "not issued".
- CLI exit codes for `dmv-agent verify` changed: `0` = confirmed good
  (issued, or format-only + valid check digit), `1` = confirmed bad (invalid
  check digit, or a live lookup that came back `not_found`), `2` =
  inconclusive (live check unavailable and fell back, or the Worker reported
  `unavailable`). Previously the command only ever exited `0` or `1`, purely
  from the offline check digit.
- New exports from the package root: `verifyCertificate`,
  `formatVerificationResult`, `exitCodeForVerification` (`src/lookup.ts`).
  `verifyCertificateId` (offline-only) is unchanged and still exported for
  callers that explicitly want the old check-digit-only behavior.

### Fixed — 429 from the live lookup was mislabeled "malformed"

The Worker's rate-limit response (`{error: "rate_limited",
retry_after_seconds}`, both the coarse Cloudflare limiter and the exact
per-IP Durable Object one) has no `status` field, so it was falling into the
generic JSON-shape check and being reported as "lookup returned a malformed
response (HTTP 429)" — misleading, since the response was well-formed, and
`retry_after_seconds` was silently dropped. `verifyCertificate()` now checks
an exact HTTP 429 `{error, retry_after_seconds}` envelope before the result
shape check and returns a distinct
`rateLimited: true` result (plus `retryAfterSeconds` when the Worker's body
included it). `formatVerificationResult()` reports it plainly ("live
issuance check is rate limited right now... Retry after Ns.") and treats it
as inconclusive, not a negative result — exit code stays `2`, and the MCP
tool does not set `isError`.

### Fixed — live lookup response validation is fail-safe

The client now sends `redirect: "manual"` and requires the Worker's exact
HTTP/body/ID/canonical-certificate-URL relationships. HTTP 200 accepts only
the exact six-field `issued` or `not_found` union; HTTP 503 accepts only the
exact six-field `unavailable` union as live/inconclusive; HTTP 429 accepts only
the exact rate-limit envelope as live/inconclusive. Every unexpected status,
redirect, partial object, extra field, mismatched ID, invalid canonical URL,
or inconsistent boolean/status combination is inconclusive and format-only.

### Compatibility

No wire-protocol changes to `/api/register`. The registry releases remain
published `@agentcommunity/dmv-agent@0.2.2` and published compatibility alias
`dmv-agent@0.1.2`. This source tree prepares canonical source `0.3.0` and alias
source `0.1.3`; the alias already depends on `@agentcommunity/dmv-agent@^0.3.0`.
Neither source version is published. Release owners must publish the canonical
package first, verify it from the registry, and only then publish the alias.

## 0.2.2 and earlier

See git history — no changelog was kept before 0.3.0.

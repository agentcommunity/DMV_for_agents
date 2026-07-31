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
- If the live call fails for any reason (network error, timeout, malformed
  response, or the lookup service reporting itself unavailable), the tool
  **automatically falls back** to the offline check-digit validation instead
  of erroring out. The response text always states plainly which check
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

### Compatibility

No wire-protocol changes to `/api/register`. `dmv-agent@0.1.1` (the
unscoped alias) now requires `@agentcommunity/dmv-agent@^0.3.0`.

## 0.2.1 and earlier

See git history — no changelog was kept before 0.3.0.

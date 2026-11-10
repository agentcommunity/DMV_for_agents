# Supabase key switch: DMV edge functions (H17, H18, H19)

Source plan: PAGE `docs/plans/2026-11-08-supabase-key-migration.md` (batch A step 6; probes P-EDGE-OUT and
P-DMV; gate G-CODE; rollback section 7). Project: Main, `tcymqfwwphacnosnnzxl`.

| Holder | Function | Key (name in `SUPABASE_SECRET_KEYS`) | Legacy fallback |
|---|---|---|---|
| H17 | `badge` | `dmv_read` | none (removed in the cut-over release) |
| H18 | `lookup-agent` | `dmv_read` | none (removed in the cut-over release) |
| H19 | `register-agent` | `dmv_register` | none (removed in the cut-over release) |

**State: cut-over release.** The legacy fallback, its `DMV_LEGACY_KEY_FALLBACK` switch and the transition
mode of the G-CODE test are deleted. The platform still injects the legacy service_role variable until plan
step F2; no DMV function reads it, and G-CODE fails if anything in a holder's import graph does.

## How the code behaves

- All three functions get their client from `_shared/supabase-key.ts`. That file holds the one pinned
  supabase-js import (`2.53.0`; it was a floating `@2` before).
- The loader reads the named entry from the platform-injected `SUPABASE_SECRET_KEYS` JSON dictionary. It never
  uses the `default` entry. If the entry exists but does not start with `sb_secret_`, the function fails closed:
  lookup returns 500, register returns 500 before any write, and badge falls back to the check-digit badge (HTTP 200) and logs
  `dmv_alert event=badge_key_error key_name=dmv_read reason=<missing|misconfigured> fallback=check_digit`
  (a missing `SUPABASE_URL` logs `key_name=SUPABASE_URL reason=url_missing`).
  Alert on that line: after the cut-over it is the only sign that every badge has degraded.
- If the entry is absent, or `SUPABASE_SECRET_KEYS` is missing or not a JSON object, the loader fails closed
  (same responses as above). There is no other key source.
- Each client creation logs one line with the key name, kind, source and fingerprint. It never logs the key:
  `supabase_key key_name=dmv_read key_kind=sb_secret key_source=SUPABASE_SECRET_KEYS key_fp=<12 hex>`.
  `key_fp` is the first 12 hex characters of sha256(key), the same value the owner records in the wave ledger.
- With an `sb_secret_` key, a fetch wrapper removes the `Authorization: Bearer <key>` header that supabase-js
  2.53.0 adds (`lib/fetch.js` `fetchWithAuth`), so the key goes out only on `apikey`. Docs: "Send publishable and
  secret keys on the `apikey` header, not on `Authorization: Bearer`." (https://supabase.com/docs/guides/api/api-keys,
  read 2026-11-08).
- `--no-verify-jwt` stays on every deploy. The `x-dmv-proxy` gate is unchanged.

## Owner steps (one function per deploy, outside the plan's cron windows)

1. In the dashboard for Main, go to Project Settings, then API Keys, then Secret keys. Create a key named `dmv_read`,
   and later a key named `dmv_register`. Record each fingerprint in the wave ledger from the owner shell:
   `printf %s "$KEY" | shasum -a 256 | cut -c1-12`, with `$KEY` read silently. Never paste the key into chat or a file.
2. There is no store to fill. The edge runtime exposes secret keys as `SUPABASE_SECRET_KEYS`, a JSON dictionary
   keyed by key name (https://supabase.com/docs/guides/functions/secrets, read 2026-11-08). **UNVERIFIED:** the docs
   do not say that a newly created named key shows up in the dictionary without a redeploy. The probe's `key_source`
   field settles it: `legacy` means the key did not show up.
3. Before each deploy, read the function's current state (D6, names and flags only):
   `curl -s -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" https://api.supabase.com/v1/projects/tcymqfwwphacnosnnzxl/functions/<slug> | jq '{version, verify_jwt, status}'`.
   Record the version and `verify_jwt` for rollback. Plan U11: the deployed code may differ from `main`, so compare
   before overwriting.
4. Deploy from this branch, in this order: `lookup-agent`, then `badge`, then `register-agent`:
   `supabase functions deploy <slug> --project-ref tcymqfwwphacnosnnzxl --no-verify-jwt`.

## Probe (plan section 6: P-EDGE-OUT + P-DMV)

- G-CODE gate: `pnpm test:edge`. It scans each function's import graph for legacy key names and for
  Bearer-with-key, `default`-entry reads and `Deno.env.toObject`, checks that each function uses its named key,
  and checks the supabase-js pin. CI runs it on every pull request and push to `main`
  (`.github/workflows/edge-functions.yml`) and in the publish gate (`pnpm test`); still run it locally before
  each deploy and record the output in the wave ledger.
- D6 GET again: the version went up and `verify_jwt` is unchanged (`false`).
- Function logs (dashboard, Edge Functions, Logs) show `key_kind=sb_secret key_source=SUPABASE_SECRET_KEYS` and a
  `key_fp` equal to the ledger value.
- Functional checks:
  - H17: badge for a known certificate returns an SVG with the agent name.
  - H18: a Worker lookup of a known certificate returns `issued`. The `BADGE_CACHE_KV` result cache can hide the
    edge call, so use a certificate that is not cached, or check that the log line appeared.
  - H19: needs one real test registration through the Worker (`packages/dmv-agent/DEPLOY.md`, "Verify it's
    running"). This writes production rows, so the owner decides. `dmv-agent doctor` alone is not enough, because
    its validation-only register (400) never creates a client.

## Cut-over (before plan step F2)

Done in code by the cut-over release (fallback, switch and transition mode deleted; G-CODE is always
enforcing). Merge it only after H17, H18 and H19 each logged `key_kind=sb_secret key_source=SUPABASE_SECRET_KEYS`
with the ledger `key_fp` (8a records), and before F2. Then `pnpm test:edge` passes and the three functions are
redeployed as in step 4, one at a time, `--no-verify-jwt` kept; each probe must show `key_source=SUPABASE_SECRET_KEYS`.

## Rollback (plan section 7)

- Redeploy the previous function version, keeping `verify_jwt` as recorded in step 3. The platform keeps injecting
  the legacy key until F2, so the old code works.
- After the cut-over release, deleting or renaming a named key in the dashboard makes that function fail closed
  (no fallback). Recover by restoring the key, or by redeploying the previous (fallback) version until F2.

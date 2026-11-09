# Supabase key switch: DMV edge functions (H17, H18, H19)

Source plan: PAGE `docs/plans/2026-11-08-supabase-key-migration.md` (batch A step 6; probes P-EDGE-OUT and
P-DMV; gate G-CODE; rollback section 7). Project: Main, `tcymqfwwphacnosnnzxl`.

| Holder | Function | New key (name in `SUPABASE_SECRET_KEYS`) | Legacy fallback |
|---|---|---|---|
| H17 | `badge` | `dmv_read` | `SUPABASE_SERVICE_ROLE_KEY` |
| H18 | `lookup-agent` | `dmv_read` | `SUPABASE_SERVICE_ROLE_KEY` |
| H19 | `register-agent` | `dmv_register` | `SUPABASE_SERVICE_ROLE_KEY` |

## How the code behaves

- All three functions get their client from `_shared/supabase-key.ts`. That file holds the switch,
  `DMV_LEGACY_KEY_FALLBACK`, and the one pinned supabase-js import (`2.53.0`; it was a floating `@2` before).
- The loader reads the named entry from the platform-injected `SUPABASE_SECRET_KEYS` JSON dictionary. It never
  uses the `default` entry. If the entry exists but does not start with `sb_secret_`, the function fails closed:
  lookup returns 500, register returns 500 before any write, and badge falls back to the check-digit badge.
- If the entry is absent and the switch is `true`, the loader falls back to the legacy key. When the switch is
  `false`, a missing entry fails closed.
- Each client creation logs one line with the key name, kind, source and fingerprint. It never logs the key:
  `supabase_key key_name=dmv_read key_kind=sb_secret key_source=SUPABASE_SECRET_KEYS key_fp=<12 hex>`.
  `key_fp` is the first 12 hex characters of sha256(key), the same value the owner records in the wave ledger.
- With an `sb_secret_` key, a fetch wrapper removes the `Authorization: Bearer <key>` header that supabase-js
  2.53.0 adds (`lib/fetch.js` `fetchWithAuth`), so the key goes out only on `apikey`. Docs: "Send publishable and
  secret keys on the `apikey` header, not on `Authorization: Bearer`." (https://supabase.com/docs/guides/api/api-keys,
  read 2026-11-08). A legacy JWT keeps today's headers.
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

1. In `_shared/supabase-key.ts`, set `DMV_LEGACY_KEY_FALLBACK = false` and delete the line marked
   `g-code-allow: legacy-fallback`. Remove its allow-list entry in `_shared/g-code.test.ts`.
2. To preview this before editing, run `pnpm test:edge:enforce`. Today it fails on purpose with 3 failures, all on
   the fallback line.
3. `pnpm test:edge` passes, then redeploy the three functions as in step 4.

## Rollback (plan section 7)

- Redeploy the previous function version, keeping `verify_jwt` as recorded in step 3. The platform keeps injecting
  the legacy key until F2, so the old code works.
- While the switch is still `true`, deleting the named key from the dashboard also sends the function back to the
  legacy key without a deploy. **UNVERIFIED:** this depends on the dictionary dropping the deleted name.

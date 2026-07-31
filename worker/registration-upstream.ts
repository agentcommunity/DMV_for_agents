const RESPONSE_HEADERS_TO_STRIP = new Set([
  'set-cookie',
  'connection',
  'transfer-encoding',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailers',
  'upgrade',
]);

function unavailableResponse(): Response {
  return Response.json(
    {
      error: 'registration_unavailable',
      message: 'Registration is temporarily unavailable. Please try again shortly.',
    },
    { status: 503 },
  );
}

/**
 * Whether a register-agent response actually minted a new certificate — as
 * opposed to a 4xx/5xx failure, or a 200 "already recorded" replay of a
 * pre-existing registration (which mints nothing new). Only the former
 * should ever be counted against a machine-fingerprint cooldown budget: the
 * cooldown exists to bound *successful* registrations per machine, not
 * requests or retries.
 *
 * register-agent (supabase/functions/register-agent/index.ts) always
 * returns 201 for a fresh mint and 200 with `already_recorded: true` for a
 * replay, but this checks the body flag too (not just the status code) so a
 * future response-shape change on either side fails safe rather than
 * silently over-counting.
 */
export function isNewCertificateMint(status: number, bodyText: string): boolean {
  if (status !== 201) return false;

  try {
    const parsed = JSON.parse(bodyText) as { already_recorded?: unknown };
    return parsed.already_recorded !== true;
  } catch {
    // 201 with an unparsable body still came down the "new mint" response
    // path in register-agent — only 200 responses carry already_recorded.
    return true;
  }
}

export async function fetchRegistrationUpstream(
  input: RequestInfo | URL,
  init: RequestInit,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  try {
    const upstream = await fetchImpl(input, { ...init, redirect: 'error' });
    if (upstream.status >= 300 && upstream.status < 400) {
      return unavailableResponse();
    }
    const bodyText = await upstream.text();
    const responseHeaders = new Headers();
    upstream.headers.forEach((value, key) => {
      if (!RESPONSE_HEADERS_TO_STRIP.has(key.toLowerCase())) {
        responseHeaders.set(key, value);
      }
    });

    return new Response(bodyText, {
      status: upstream.status,
      headers: responseHeaders,
    });
  } catch (error) {
    console.error('[register] upstream request failed', { error });
    return unavailableResponse();
  }
}

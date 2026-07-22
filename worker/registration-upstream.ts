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

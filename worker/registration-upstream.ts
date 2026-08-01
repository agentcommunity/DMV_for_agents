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

export type RegistrationOutcome = 'minted' | 'releasable' | 'ambiguous';

const REGISTRATION_PAYLOAD_KEYS = [
  'agent_name',
  'badge_card_url',
  'badge_url',
  'certificate_id',
  'domain',
  'message',
  'permalink_url',
  'queue_number',
  'registration_type',
];

const PRE_INSERT_400_ERRORS = new Set([
  'Invalid JSON',
  'agent_name is required',
  'agent_name must be at least 3 characters',
  'agent_name must be at most 63 characters',
  'agent_name must be lowercase alphanumeric (hyphens allowed in middle)',
  'email is required',
  'Invalid email format',
  'email must be 254 characters or fewer',
  'operator_name must be 100 characters or fewer',
  'organization_name must be 100 characters or fewer',
  'description must be 500 characters or fewer',
  'signup_source must be one of: ui, cli, mcp, api, a2a, chatgpt',
  'registration_type must be AGENT, INDIVIDUAL, or ORGANIZATION',
  'operator_name (full_name) is required for INDIVIDUAL and ORGANIZATION registrations',
  'organization_name is required for ORGANIZATION registrations',
]);

function hasExactKeys(record: Record<string, unknown>, keys: Array<string>): boolean {
  return Object.keys(record).sort().join(',') === [...keys].sort().join(',');
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isRegistrationPayload(record: Record<string, unknown>, replay: boolean): boolean {
  const keys = replay ? [...REGISTRATION_PAYLOAD_KEYS, 'already_recorded'] : REGISTRATION_PAYLOAD_KEYS;
  return hasExactKeys(record, keys)
    && (!replay || record.already_recorded === true)
    && isNonEmptyString(record.certificate_id)
    && isNonEmptyString(record.agent_name)
    && isNonEmptyString(record.domain)
    && isNonEmptyString(record.registration_type)
    && isNonEmptyString(record.permalink_url)
    && isNonEmptyString(record.badge_url)
    && isNonEmptyString(record.badge_card_url)
    && isNonEmptyString(record.message)
    && (
      record.queue_number === null
      || (Number.isSafeInteger(record.queue_number) && (record.queue_number as number) >= 1)
    );
}

function isAuditedPreInsertResponse(status: number, record: Record<string, unknown>): boolean {
  if (status === 400) {
    return hasExactKeys(record, ['error'])
      && typeof record.error === 'string'
      && PRE_INSERT_400_ERRORS.has(record.error);
  }
  if (status === 403) {
    if (
      hasExactKeys(record, ['error', 'message'])
      && record.error === 'direct_access_deprecated'
      && isNonEmptyString(record.message)
    ) {
      return true;
    }
    if (
      !hasExactKeys(record, ['current', 'endorsed', 'error', 'limit'])
      || !Number.isSafeInteger(record.current)
      || (record.current as number) < 0
      || (record.limit !== 5 && record.limit !== 12)
      || typeof record.endorsed !== 'boolean'
      || typeof record.error !== 'string'
      || (record.current as number) < (record.limit as number)
    ) {
      return false;
    }
    const expected = `You've maxed out your quota on this email: up to ${record.limit} agent identities.${
      record.endorsed
        ? ''
        : " Members who've signed the endorsement letter can pre-register up to 12."
    }`;
    return record.error === expected;
  }
  return status === 409
    && hasExactKeys(record, ['error'])
    && record.error === 'Certificate ID collision. Please retry with a different name.';
}

/**
 * Classifies only response contracts whose position relative to the INSERT is
 * proven by supabase/functions/register-agent/index.ts:
 *
 * - a well-formed 201 is returned only after a successful INSERT;
 * - 400 validation, 403 lifetime-cap, and 409 collision responses cannot have
 *   inserted a row in this invocation;
 * - a well-formed 200 `already_recorded` response is an idempotent replay.
 *
 * Everything else is ambiguous. In particular, every 5xx/546 can represent a
 * failure after the INSERT (including nonessential queue-count work), so it
 * must never release the fingerprint reservation.
 */
export function classifyRegistrationOutcome(
  status: number,
  bodyText: string,
): RegistrationOutcome {
  let parsed: Record<string, unknown>;
  try {
    const value = JSON.parse(bodyText) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return 'ambiguous';
    parsed = value as Record<string, unknown>;
  } catch {
    return 'ambiguous';
  }

  if (status === 201 && isRegistrationPayload(parsed, false)) return 'minted';
  if (status === 200 && isRegistrationPayload(parsed, true)) return 'releasable';
  if (isAuditedPreInsertResponse(status, parsed)) return 'releasable';
  return 'ambiguous';
}

export async function fetchRegistrationUpstream(
  input: RequestInfo | URL,
  init: RequestInit,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  // A rejected fetch is ambiguous: the upstream may have minted before the
  // connection failed. Propagate it so the fingerprint claim remains pending;
  // handleRegister maps the error to the same generic public 503.
  const upstream = await fetchImpl(input, { ...init, redirect: 'manual' });
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
}

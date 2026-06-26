export type DoctorCheckStatus = 'pass' | 'fail';

export interface DoctorCheck {
  label: string;
  status: DoctorCheckStatus;
  detail: string;
}

export interface DoctorResult {
  ok: boolean;
  baseUrl: string;
  checks: Array<DoctorCheck>;
}

export interface RunDoctorOptions {
  baseUrl?: string;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
}

const DEFAULT_BASE_URL = 'https://dmv.agentcommunity.org';
const DEFAULT_TIMEOUT_MS = 10_000;
const SMOKE_CERT_ID = 'MESA-DD6-660J';

export async function runDoctor({
  baseUrl = process.env.DMV_BASE_URL ?? DEFAULT_BASE_URL,
  fetchFn = fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}: RunDoctorOptions = {}): Promise<DoctorResult> {
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
  const checks = await Promise.all([
    checkHealthz(normalizedBaseUrl, fetchFn, timeoutMs),
    checkCard(normalizedBaseUrl, fetchFn, timeoutMs),
    checkBadge(normalizedBaseUrl, fetchFn, timeoutMs),
    checkRegisterValidation(normalizedBaseUrl, fetchFn, timeoutMs),
  ]);

  return {
    ok: checks.every((check) => check.status === 'pass'),
    baseUrl: normalizedBaseUrl,
    checks,
  };
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '') || DEFAULT_BASE_URL;
}

async function checkHealthz(
  baseUrl: string,
  fetchFn: typeof fetch,
  timeoutMs: number,
): Promise<DoctorCheck> {
  const response = await safeFetch(fetchFn, `${baseUrl}/healthz`, { method: 'GET' }, timeoutMs);
  if (!response.ok || !response.response) return fail('healthz', response.detail);

  let detail = `HTTP ${response.response.status}`;
  try {
    const payload = await response.response.clone().json() as { worker?: string; container?: { status?: string } };
    const workerStatus = payload.worker ?? 'unknown';
    const containerStatus = payload.container?.status ?? 'unknown';
    detail = `worker=${workerStatus} container=${containerStatus}`;
    if (workerStatus !== 'ok' || containerStatus !== 'ok') {
      return fail('healthz', detail);
    }
  } catch {
    return fail('healthz', 'health response is not valid JSON');
  }

  return pass('healthz', detail);
}

async function checkCard(
  baseUrl: string,
  fetchFn: typeof fetch,
  timeoutMs: number,
): Promise<DoctorCheck> {
  const url = `${baseUrl}/api/card?id=${SMOKE_CERT_ID}&name=dmv&type=individual`;
  const response = await safeFetch(fetchFn, url, { method: 'GET' }, timeoutMs);
  if (!response.ok || !response.response) return fail('card png', response.detail);

  const contentType = response.response.headers.get('content-type') ?? '';
  if (!contentType.includes('image/png')) {
    return fail('card png', `expected image/png, got ${contentType || 'missing content-type'}`);
  }

  const contentLength = response.response.headers.get('content-length');
  return pass('card png', contentLength ? `image/png ${contentLength} bytes` : 'image/png');
}

async function checkBadge(
  baseUrl: string,
  fetchFn: typeof fetch,
  timeoutMs: number,
): Promise<DoctorCheck> {
  const response = await safeFetch(fetchFn, `${baseUrl}/badge?id=${SMOKE_CERT_ID}`, { method: 'GET' }, timeoutMs);
  if (!response.ok || !response.response) return fail('badge svg', response.detail);

  const contentType = response.response.headers.get('content-type') ?? '';
  if (!contentType.includes('image/svg+xml')) {
    return fail('badge svg', `expected image/svg+xml, got ${contentType || 'missing content-type'}`);
  }

  return pass('badge svg', 'image/svg+xml');
}

async function checkRegisterValidation(
  baseUrl: string,
  fetchFn: typeof fetch,
  timeoutMs: number,
): Promise<DoctorCheck> {
  const response = await safeFetch(
    fetchFn,
    `${baseUrl}/api/register`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    },
    timeoutMs,
  );
  if (!response.response) return fail('register validation', response.detail);

  let errorMessage = '';
  try {
    const payload = await response.response.clone().json() as { error?: string; message?: string };
    errorMessage = payload.error ?? payload.message ?? '';
  } catch {
    // The status still decides the check below.
  }

  if (response.response.status !== 400 || !errorMessage.includes('agent_name')) {
    return fail(
      'register validation',
      `expected 400 agent_name validation, got HTTP ${response.response.status}`,
    );
  }

  return pass('register validation', 'empty payload rejected with agent_name validation');
}

async function safeFetch(
  fetchFn: typeof fetch,
  input: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<{ ok: boolean; response?: Response; detail: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchFn(input, { ...init, signal: controller.signal });
    return {
      ok: response.ok,
      response,
      detail: `HTTP ${response.status}`,
    };
  } catch (err) {
    const detail = err instanceof Error && err.name === 'AbortError'
      ? `timed out after ${timeoutMs}ms`
      : err instanceof Error
        ? err.message
        : String(err);
    return { ok: false, detail };
  } finally {
    clearTimeout(timeout);
  }
}

function pass(label: string, detail: string): DoctorCheck {
  return { label, status: 'pass', detail };
}

function fail(label: string, detail: string): DoctorCheck {
  return { label, status: 'fail', detail };
}

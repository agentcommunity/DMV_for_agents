// DMV registration client — calls edge function proxy
// No database credentials in client code.

const REGISTER_ENDPOINT =
  '/api/register';

// Feature flag — set to true when ready to persist registrations
export const SUPABASE_ENABLED = true;

/**
 * Insert a registration via the edge function proxy.
 * Maps CRT form data to the API contract.
 *
 * @param {object} formData - from CRTTerminal.getFormData()
 * @param {string} signupSource - 'ui' | 'mcp' | 'api'
 * @param {string | null} turnstileToken
 * @returns {object} { data, error }
 */
export async function insertRegistration(formData, signupSource = 'ui', turnstileToken = null) {
  if (!SUPABASE_ENABLED) {
    console.log('[dmv] Persistence disabled. Registration data:', formData);
    return { data: null, error: null };
  }

  const registrationType = formData.accountType === 'org' ? 'ORGANIZATION'
    : formData.accountType === 'agent' ? 'AGENT'
    : 'INDIVIDUAL';

  const body = {
    agent_name: formData.agentName || '',
    email: formData.email || formData.orgEmail || formData.operatorEmail || '',
    operator_name: formData.userName || null,
    organization_name: formData.companyName || null,
    signup_source: signupSource,
    registration_type: registrationType,
  };
  if (turnstileToken) {
    body['cf-turnstile-response'] = turnstileToken;
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    const res = await fetch(REGISTER_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    let json;
    try {
      json = await res.json();
    } catch {
      return { data: null, error: { message: `Server returned an unexpected response (HTTP ${res.status})` } };
    }

    if (!res.ok) {
      console.error('[dmv] Registration error:', json.error || json.message);
      return { data: null, error: { message: json.message || json.error || `Registration failed (HTTP ${res.status})` } };
    }

    return { data: json, error: null };
  } catch (err) {
    const msg = err.name === 'AbortError'
      ? 'Registration timed out. Please check your connection and try again.'
      : err.message;
    console.error('[dmv] Network error:', err);
    return { data: null, error: { message: msg } };
  }
}

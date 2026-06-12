import { validateAgentRegistration } from './validate.js';
import type {
  AgentRegistration,
  RegistrationResult,
  SignupSource,
} from './types.js';

const REGISTER_ENDPOINT =
  process.env.DMV_API_ENDPOINT?.trim()
  || 'https://dmv.agentcommunity.org/api/register';

/**
 * Register an agent identity at the DMV via the edge function proxy.
 * No database credentials are used client-side.
 *
 * @param data - Agent registration fields
 * @param source - Where the signup came from ('mcp' | 'cli' | 'api' | 'ui')
 * @returns Registration result with certificate ID
 */
export async function registerAgent(
  data: AgentRegistration,
  source: SignupSource = 'mcp',
  machineFingerprint?: string,
): Promise<RegistrationResult> {
  // Client-side validation (fast feedback before network call)
  const errors = validateAgentRegistration(data);
  if (errors.length > 0) {
    const msg = errors.map((e) => `${e.field}: ${e.message}`).join('; ');
    throw new Error(`Validation failed: ${msg}`);
  }

  const body: Record<string, unknown> = {
    agent_name: data.agentName,
    email: data.email,
    operator_name: data.operatorName || null,
    description: data.description || null,
    signup_source: source,
    registration_type: 'AGENT',
  };
  if (machineFingerprint) {
    body.machine_fingerprint = machineFingerprint;
  }

  const MAX_RETRIES = 2;
  const TIMEOUT_MS = 30_000;
  let res: Response | undefined;
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      res = await fetch(REGISTER_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      clearTimeout(timeout);
      // Only retry on 5xx server errors
      if (res.status < 500) break;
      lastError = new Error(`Server error (HTTP ${res.status})`);
    } catch (err) {
      clearTimeout(timeout);
      const msg = (err as Error).name === 'AbortError'
        ? 'Request timed out after 30 seconds'
        : `Network error: ${(err as Error).message}`;
      lastError = new Error(msg);
    }
    // Exponential backoff before retry
    if (attempt < MAX_RETRIES) {
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
    }
  }

  if (!res || res.status >= 500) {
    throw lastError || new Error('Registration failed after retries');
  }

  const text = await res.text();
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`Server returned invalid response (HTTP ${res.status}): ${text.slice(0, 200)}`);
  }

  if (!res.ok) {
    throw new Error((json.message as string) || (json.error as string) || `Registration failed (HTTP ${res.status})`);
  }

  return {
    certificateId: json.certificate_id as string,
    agentName: json.agent_name as string,
    domain: json.domain as string,
    message: json.message as string,
    queueNumber: typeof json.queue_number === 'number' ? json.queue_number : null,
  };
}

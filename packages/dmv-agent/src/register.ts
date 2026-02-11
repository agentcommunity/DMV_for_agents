import { validateAgentRegistration } from './validate.js';
import type {
  AgentRegistration,
  RegistrationResult,
  SignupSource,
} from './types.js';

const REGISTER_ENDPOINT =
  'https://tcymqfwwphacnosnnzxl.supabase.co/functions/v1/register-agent';

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
): Promise<RegistrationResult> {
  // Client-side validation (fast feedback before network call)
  const errors = validateAgentRegistration(data);
  if (errors.length > 0) {
    const msg = errors.map((e) => `${e.field}: ${e.message}`).join('; ');
    throw new Error(`Validation failed: ${msg}`);
  }

  const body = {
    agent_name: data.agentName,
    email: data.email,
    operator_name: data.operatorName || null,
    description: data.description || null,
    signup_source: source,
    registration_type: 'AGENT',
  };

  let res: Response;
  try {
    res = await fetch(REGISTER_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new Error(
      `Network error: could not reach DMV registration service. ${(err as Error).message}`,
    );
  }

  const json = await res.json();

  if (!res.ok) {
    throw new Error(json.error || `Registration failed (HTTP ${res.status})`);
  }

  return {
    certificateId: json.certificate_id,
    agentName: json.agent_name,
    domain: json.domain,
    message: json.message,
  };
}

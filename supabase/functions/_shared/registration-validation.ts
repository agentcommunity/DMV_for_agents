// Shared registration field-validation rules — the single source of truth for
// both the DMV Worker (worker/index.ts, bundled by wrangler/esbuild) and the
// register-agent Supabase edge function (Deno). Previously these rules were
// duplicated in both files and could silently drift.
//
// Import notes:
//   - register-agent (Deno): `../_shared/registration-validation.ts`
//   - worker (esbuild):      `../supabase/functions/_shared/registration-validation.ts`
//   The explicit `.ts` extension is required by Deno and tolerated by esbuild.
//
// IMPORTANT: error strings are surfaced verbatim to clients (CLI/MCP/web) and
// are asserted in AUTH_DMV.md's test steps — keep them stable. Check ORDER also
// matters: callers return the FIRST error, so the sequence below is the
// contract.

export const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const AGENT_NAME_REGEX = /^[a-z0-9][a-z0-9-]*[a-z0-9]$/;

export const SIGNUP_SOURCES = ['ui', 'cli', 'mcp', 'api'] as const;
export const REGISTRATION_TYPES = ['AGENT', 'INDIVIDUAL', 'ORGANIZATION'] as const;

export const FIELD_LIMITS = {
  agentNameMin: 3,
  agentNameMax: 63, // DNS label max per RFC 1035
  emailMax: 254,
  operatorNameMax: 100,
  organizationNameMax: 100,
  descriptionMax: 500,
} as const;

/**
 * Canonicalize a user-supplied agent name BEFORE validation: trim, lowercase,
 * and strip any user-typed trailing `.agent` suffix(es). The system appends
 * `.agent` when composing `domain_requested`, so the slug must be bare ("mybot",
 * not "mybot.agent"). Without this, a pasted "mybot.agent" would fail the
 * dot-free AGENT_NAME_REGEX outright — this turns that confusing rejection into
 * graceful acceptance, rather than guarding against any real "mybot.agent.agent".
 */
export function normalizeAgentName(raw: unknown): string {
  let name = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  while (name.endsWith('.agent')) name = name.slice(0, -'.agent'.length);
  return name;
}

export interface RegistrationFields {
  agent_name?: string;
  email?: string;
  operator_name?: string;
  organization_name?: string;
  description?: string;
  signup_source?: string;
  registration_type?: string;
}

/**
 * Validate the registration fields. Returns the first error message, or null
 * if all rules pass. Callers are responsible for any parsing/normalization
 * (trimming, lowercasing email, defaulting signup_source/registration_type)
 * BEFORE calling this — it validates the values it is given.
 */
export function validateRegistrationFields(f: RegistrationFields): string | null {
  const name = f.agent_name;
  if (!name) return 'agent_name is required';
  if (name.length < FIELD_LIMITS.agentNameMin) return 'agent_name must be at least 3 characters';
  if (name.length > FIELD_LIMITS.agentNameMax) return 'agent_name must be at most 63 characters';
  if (!AGENT_NAME_REGEX.test(name)) {
    return 'agent_name must be lowercase alphanumeric (hyphens allowed in middle)';
  }

  const email = f.email;
  if (!email) return 'email is required';
  if (!EMAIL_REGEX.test(email)) return 'Invalid email format';
  if (email.length > FIELD_LIMITS.emailMax) return 'email must be 254 characters or fewer';

  if (f.operator_name && f.operator_name.length > FIELD_LIMITS.operatorNameMax) {
    return 'operator_name must be 100 characters or fewer';
  }
  if (f.organization_name && f.organization_name.length > FIELD_LIMITS.organizationNameMax) {
    return 'organization_name must be 100 characters or fewer';
  }
  if (f.description && f.description.length > FIELD_LIMITS.descriptionMax) {
    return 'description must be 500 characters or fewer';
  }

  if (f.signup_source && !(SIGNUP_SOURCES as readonly string[]).includes(f.signup_source)) {
    return 'signup_source must be ui, cli, mcp, or api';
  }
  if (f.registration_type && !(REGISTRATION_TYPES as readonly string[]).includes(f.registration_type)) {
    return 'registration_type must be AGENT, INDIVIDUAL, or ORGANIZATION';
  }

  // full_name (operator_name) required for INDIVIDUAL and ORGANIZATION
  if ((f.registration_type === 'INDIVIDUAL' || f.registration_type === 'ORGANIZATION') && !f.operator_name) {
    return 'operator_name (full_name) is required for INDIVIDUAL and ORGANIZATION registrations';
  }
  // organization_name required for ORGANIZATION
  if (f.registration_type === 'ORGANIZATION' && !f.organization_name) {
    return 'organization_name is required for ORGANIZATION registrations';
  }

  return null;
}

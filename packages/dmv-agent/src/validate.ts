const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const CONSUMER_DOMAINS = [
  'gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com',
  'icloud.com', 'aol.com', 'protonmail.com', 'live.com', 'googlemail.com',
];

const AGENT_NAME_REGEX = /^[a-z0-9][a-z0-9-]*[a-z0-9]$/;

export const FIELD_LIMITS = {
  operatorNameMax: 100,
  descriptionMax: 500,
} as const;

export interface ValidationError {
  field: string;
  message: string;
}

/**
 * Canonicalize a user-supplied agent name before validation: trim, lowercase,
 * and strip any trailing `.agent` suffix(es). The system appends `.agent` when
 * composing the domain, so "mybot.agent" must become "mybot" — never
 * "mybot.agent.agent". Mirrors the server-side normalizeAgentName.
 */
export function normalizeAgentName(raw: string): string {
  let name = (raw || '').trim().toLowerCase();
  while (name.endsWith('.agent')) name = name.slice(0, -'.agent'.length);
  return name;
}

export function validateAgentName(name: string): string | null {
  if (!name) return 'Agent name is required';
  if (name.length < 3) return 'Agent name must be at least 3 characters';
  if (name.length > 63) return 'Agent name must be at most 63 characters';
  if (!AGENT_NAME_REGEX.test(name)) {
    return 'Agent name must be lowercase alphanumeric (hyphens allowed in middle)';
  }
  return null;
}

export function validateEmail(email: string): string | null {
  if (!email) return 'Email is required';
  if (!EMAIL_REGEX.test(email)) return 'Invalid email format';
  return null;
}

export function validateOperatorName(operatorName?: string): string | null {
  const value = operatorName?.trim() ?? '';
  if (!value) return 'Operator name is required';
  if (value.length > FIELD_LIMITS.operatorNameMax) {
    return `Operator name must be ${FIELD_LIMITS.operatorNameMax} characters or fewer`;
  }
  return null;
}

export function validateDescription(description?: string): string | null {
  const value = description?.trim() ?? '';
  if (value.length > FIELD_LIMITS.descriptionMax) {
    return `Description must be ${FIELD_LIMITS.descriptionMax} characters or fewer`;
  }
  return null;
}

export function validateOrgEmail(email: string): string | null {
  const basic = validateEmail(email);
  if (basic) return basic;
  const domain = email.split('@')[1]?.toLowerCase();
  if (CONSUMER_DOMAINS.includes(domain)) {
    return 'Use an organization email, not personal';
  }
  return null;
}

export function validateAgentRegistration(data: {
  agentName: string;
  email: string;
  operatorName?: string;
  description?: string;
}): ValidationError[] {
  const errors: ValidationError[] = [];
  const nameErr = validateAgentName(data.agentName);
  if (nameErr) errors.push({ field: 'agentName', message: nameErr });
  const emailErr = validateEmail(data.email);
  if (emailErr) errors.push({ field: 'email', message: emailErr });
  if ((data.operatorName?.trim() ?? '').length > FIELD_LIMITS.operatorNameMax) {
    errors.push({
      field: 'operatorName',
      message: `Operator name must be ${FIELD_LIMITS.operatorNameMax} characters or fewer`,
    });
  }
  const descriptionErr = validateDescription(data.description);
  if (descriptionErr) errors.push({ field: 'description', message: descriptionErr });
  return errors;
}

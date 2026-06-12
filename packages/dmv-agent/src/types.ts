export type RegistrationType = 'INDIVIDUAL' | 'ORGANIZATION' | 'AGENT';
export type SignupSource = 'ui' | 'cli' | 'mcp' | 'api';

export interface AgentRegistration {
  agentName: string;
  email: string;
  operatorName?: string;
  description?: string;
}

export interface RegistrationPayload {
  registration_type: RegistrationType;
  full_name: string | null;
  organization_name: string | null;
  domain_requested: string;
  email: string;
  certificate_id: string;
  signup_source: SignupSource;
  metadata?: Record<string, unknown>;
}

export interface RegistrationResult {
  certificateId: string;
  agentName: string;
  domain: string;
  message: string;
  /** Global position in the pre-registration queue ("now serving" ticket). */
  queueNumber?: number | null;
}

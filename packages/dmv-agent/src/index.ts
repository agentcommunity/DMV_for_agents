// Public API for @agentcommunity/dmv-agent

export { registerAgent } from './register.js';
export { runDoctor } from './doctor.js';
export { generateCertificateId, verifyCertificateId, fnv1a } from './certificate.js';
export { verifyCertificate, formatVerificationResult, exitCodeForVerification } from './lookup.js';
export { validateAgentName, validateEmail, validateAgentRegistration } from './validate.js';
export { generateTextCard, generateMarkdownCard } from './text-card.js';
export type { TextCardData } from './text-card.js';
export type {
  AgentRegistration,
  RegistrationPayload,
  RegistrationResult,
  RegistrationType,
  SignupSource,
} from './types.js';
export type { DoctorCheck, DoctorResult, RunDoctorOptions } from './doctor.js';
export type {
  CertificateCheckMode,
  CertificateLookupStatus,
  CertificateVerificationResult,
  VerifyCertificateOptions,
} from './lookup.js';

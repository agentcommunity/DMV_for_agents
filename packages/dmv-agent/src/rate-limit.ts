/**
 * Client-side rate limiting for CLI pre-registration.
 * Machine fingerprint + local lockfile (~/.dmv-agent/).
 * Zero dependencies — Node built-ins only.
 */

import { createHash } from 'node:crypto';
import { hostname, userInfo, platform } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const MAX_ATTEMPTS = 3;
const WINDOW_MS = 24 * 60 * 60 * 1000; // 24 hours

interface Attempt {
  timestamp: number;
  agentName: string;
}

interface LockfileData {
  fingerprint: string;
  attempts: Attempt[];
}

/** Generate a machine fingerprint from hostname + username + platform. */
export function getMachineFingerprint(): string {
  const parts = [
    hostname(),
    userInfo().username,
    platform(),
  ];
  return createHash('sha256').update(parts.join('|')).digest('hex');
}

function getLockfilePath(): string {
  const home = process.env.HOME || process.env.USERPROFILE || '/tmp';
  return join(home, '.dmv-agent', 'registrations.json');
}

function ensureDir(filePath: string): void {
  const dir = filePath.replace(/[/\\][^/\\]+$/, '');
  mkdirSync(dir, { recursive: true });
}

function readLockfile(): LockfileData {
  const fp = getMachineFingerprint();
  try {
    const raw = readFileSync(getLockfilePath(), 'utf-8');
    const data = JSON.parse(raw) as LockfileData;
    if (data.fingerprint !== fp) {
      return { fingerprint: fp, attempts: [] };
    }
    return data;
  } catch {
    return { fingerprint: fp, attempts: [] };
  }
}

function writeLockfile(data: LockfileData): void {
  const path = getLockfilePath();
  ensureDir(path);
  writeFileSync(path, JSON.stringify(data, null, 2), 'utf-8');
}

/** Prune attempts outside the 24h window. */
function pruneAttempts(attempts: Attempt[]): Attempt[] {
  const cutoff = Date.now() - WINDOW_MS;
  return attempts.filter(a => a.timestamp > cutoff);
}

export interface RateLimitStatus {
  allowed: boolean;
  fingerprint: string;
  used: number;
  max: number;
  /** Human-readable time until next slot opens, e.g. "4h 22m" */
  retryIn: string;
}

/** Check if a new pre-registration is allowed. */
export function checkRateLimit(): RateLimitStatus {
  const data = readLockfile();
  const recent = pruneAttempts(data.attempts);
  const fp = data.fingerprint;

  if (recent.length < MAX_ATTEMPTS) {
    return {
      allowed: true,
      fingerprint: fp,
      used: recent.length,
      max: MAX_ATTEMPTS,
      retryIn: '',
    };
  }

  // Find when the oldest attempt expires
  const oldest = recent.reduce((min, a) => a.timestamp < min ? a.timestamp : min, Infinity);
  const expiresAt = oldest + WINDOW_MS;
  const remainMs = Math.max(0, expiresAt - Date.now());
  const hours = Math.floor(remainMs / (60 * 60 * 1000));
  const minutes = Math.ceil((remainMs % (60 * 60 * 1000)) / (60 * 1000));
  const retryIn = hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;

  return {
    allowed: false,
    fingerprint: fp,
    used: recent.length,
    max: MAX_ATTEMPTS,
    retryIn,
  };
}

/** Record a successful pre-registration attempt. */
export function recordAttempt(agentName: string): void {
  const data = readLockfile();
  data.attempts = pruneAttempts(data.attempts);
  data.attempts.push({ timestamp: Date.now(), agentName });
  writeLockfile(data);
}

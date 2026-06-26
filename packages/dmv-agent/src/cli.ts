#!/usr/bin/env node

/**
 * DMV Agent CLI — CRT Terminal Edition
 *
 * Modes:
 *   (default / no args)  → Start MCP server (for Claude Code integration)
 *   register              → Interactive pre-registration from terminal
 *   register --name <n> --email <e> --operator <o>  → Non-interactive
 *   verify <CERT-ID>      → Check a certificate ID's validity
 *   doctor                → Read-only DMV endpoint readiness checks
 */

import { registerAgent } from './register.js';
import { verifyCertificateId } from './certificate.js';
import { runDoctor } from './doctor.js';
import { packageVersion } from './package-info.js';
import { resolveRegistrationUrls } from './urls.js';
import {
  normalizeAgentName,
  validateAgentName,
  validateAgentRegistration,
  validateDescription,
  validateEmail,
  validateOperatorName,
} from './validate.js';
import { checkRateLimit, recordAttempt, getMachineFingerprint } from './rate-limit.js';
import {
  clearScreen, hideCursor, showCursor,
  renderBootScreen, renderFieldPrompt, renderConfirmation,
  renderProgress, renderSuccess, renderError, renderRateLimit,
  renderContentPage, validationError, validationOk, color, write,
} from './ui.js';
import { generateTextCard } from './text-card.js';
import * as readline from 'node:readline';

const VERSION = packageVersion;
const args = process.argv.slice(2);
const command = args[0];

// ─── Content ────────────────────────────────────────────────

const ABOUT_TEXT = `The Department of Machine Verification (DMV) is the agent name pre-registration system for the .agent community.

The .agent community is building toward an ICANN application for the .agent generic top-level domain (gTLD). Pre-registering your agent's identity now establishes early interest in your preferred .agent domain.

This CLI terminal is designed for agentic workflows — AI agents pre-registering their own identities. The operator (human or organization responsible for the agent) must verify via email.

For human and organization registration with the full interactive experience, visit dmv.agentcommunity.org.

Learn more at agentcommunity.org.`;

const TERMS_TEXT = `TERMS OF SERVICE — SUMMARY

Pre-registration through the DMV records your interest in a .agent domain identity. It does not guarantee domain assignment.

Multiple parties can pre-register interest in the same .agent name. This is a wishlist, not an availability check.

By pre-registering you agree to:
- Provide accurate operator contact information
- Respond to verification emails promptly
- Avoid implying ownership, priority, or DNS availability from this pre-registration
- Accept that any future assignment is subject to the .agent gTLD application process and ICANN-approved policies

Pre-registration data is stored securely. Email addresses are used solely for verification and community updates. You may request deletion at any time.

Full terms: agentcommunity.org/terms`;

const CHARTER_TEXT = `.AGENT CHARTER — SUMMARY

The .agent Charter establishes principles for machine identity:

1. IDENTITY — Every agent deserves a verifiable identity
2. TRANSPARENCY — Agents should be identifiable as non-human
3. ACCOUNTABILITY — An operator stands behind every agent
4. INTEROPERABILITY — .agent identities work across platforms
5. COMMUNITY — The .agent namespace would operate within ICANN requirements

The Charter guides the proposed use and governance of .agent names. All pre-registrants agree to uphold these principles.

Full charter: agentcommunity.org/charter`;

// ─── Input helpers ──────────────────────────────────────────

function createPromptInterface(): readline.Interface {
  return readline.createInterface({
    input: process.stdin,
    output: process.stderr,
  });
}

async function prompt(question: string): Promise<string> {
  const rl = createPromptInterface();
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function waitForKey(): Promise<string> {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
    }
    process.stdin.resume();
    process.stdin.once('data', (data) => {
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(false);
      }
      process.stdin.pause();
      const key = data.toString().toLowerCase();
      resolve(key);
    });
  });
}

// ─── Boot screen ────────────────────────────────────────────

async function showBootScreen(): Promise<void> {
  clearScreen();
  renderBootScreen(VERSION);

  while (true) {
    const key = await waitForKey();
    if (key === 'a') {
      clearScreen();
      renderContentPage('ABOUT', ABOUT_TEXT);
      await waitForKey();
      clearScreen();
      renderBootScreen(VERSION);
      continue;
    }
    if (key === 't') {
      clearScreen();
      renderContentPage('TERMS OF SERVICE', TERMS_TEXT);
      await waitForKey();
      clearScreen();
      renderBootScreen(VERSION);
      continue;
    }
    if (key === 'c') {
      clearScreen();
      renderContentPage('.AGENT CHARTER', CHARTER_TEXT);
      await waitForKey();
      clearScreen();
      renderBootScreen(VERSION);
      continue;
    }
    if (key === '\r' || key === '\n' || key === ' ') {
      break;
    }
    if (key === '\x03') {
      // Ctrl+C
      showCursor();
      process.exit(0);
    }
  }
}

// ─── Interactive form ───────────────────────────────────────

interface CollectedFields {
  agentName: string;
  operatorName: string;
  email: string;
  description?: string;
}

async function collectFields(): Promise<CollectedFields> {
  const completed: Array<{ label: string; value: string }> = [];

  // 1. Agent name
  let agentName = '';
  while (true) {
    clearScreen();
    renderFieldPrompt(
      'AGENT NAME',
      'What should this agent be called? (lowercase, 3-63 chars)',
      completed,
    );
    agentName = normalizeAgentName(await prompt(`  ${color.green('>')} `));
    const err = validateAgentName(agentName);
    if (!err) {
      validationOk(`${agentName}.agent`);
      break;
    }
    validationError(err);
    await new Promise(r => setTimeout(r, 800));
  }
  completed.push({ label: 'Agent', value: `${agentName}.agent` });

  // 2. Operator name (required)
  let operatorName = '';
  while (true) {
    clearScreen();
    renderFieldPrompt(
      'OPERATOR NAME',
      'Who operates this agent? (required)',
      completed,
    );
    operatorName = await prompt(`  ${color.green('>')} `);
    const err = validateOperatorName(operatorName);
    if (!err) {
      validationOk(`Operator: ${operatorName}`);
      break;
    }
    validationError(err);
    await new Promise(r => setTimeout(r, 800));
  }
  completed.push({ label: 'Operator', value: operatorName });

  // 3. Email
  let email = '';
  while (true) {
    clearScreen();
    renderFieldPrompt(
      'OPERATOR EMAIL',
      'A verification link will be sent here.',
      completed,
    );
    email = await prompt(`  ${color.green('>')} `);
    const err = validateEmail(email);
    if (!err) {
      validationOk(`Email: ${email}`);
      break;
    }
    validationError(err);
    await new Promise(r => setTimeout(r, 800));
  }
  completed.push({ label: 'Email', value: email });

  // 4. Description (optional)
  let description: string | undefined;
  while (true) {
    clearScreen();
    renderFieldPrompt(
      'DESCRIPTION (optional, press Enter to skip)',
      'What does this agent do?',
      completed,
    );
    description = (await prompt(`  ${color.green('>')} `)) || undefined;
    const descriptionErr = validateDescription(description);
    if (!descriptionErr) {
      if (description) {
        completed.push({ label: 'Desc', value: description });
      }
      break;
    }
    validationError(descriptionErr);
    await new Promise(r => setTimeout(r, 800));
  }

  return { agentName, operatorName, email, description };
}

// ─── Submit flow ────────────────────────────────────────────

async function confirmAndSubmit(fields: CollectedFields): Promise<void> {
  // Confirmation screen
  clearScreen();
  renderConfirmation(fields);

  // Y/n gate with terms/charter access
  while (true) {
    const answer = await prompt(`  ${color.green('Submit pre-registration? [Y/n]')} `);
    const a = answer.toLowerCase();

    if (a === 't') {
      clearScreen();
      renderContentPage('TERMS OF SERVICE', TERMS_TEXT);
      await waitForKey();
      clearScreen();
      renderConfirmation(fields);
      continue;
    }
    if (a === 'c') {
      clearScreen();
      renderContentPage('.AGENT CHARTER', CHARTER_TEXT);
      await waitForKey();
      clearScreen();
      renderConfirmation(fields);
      continue;
    }
    if (a === 'n' || a === 'no') {
      process.stderr.write(`\n  ${color.greenDim('Pre-registration cancelled.')}\n\n`);
      process.exit(0);
    }
    if (a === '' || a === 'y' || a === 'yes') {
      break;
    }
  }

  // Submit
  clearScreen();
  process.stderr.write('\n');
  await renderProgress('PROCESSING');
  process.stderr.write('\n');

  try {
    const fingerprint = getMachineFingerprint();
    const result = await registerAgent(
      {
        agentName: fields.agentName,
        email: fields.email,
        operatorName: fields.operatorName,
        description: fields.description,
      },
      'cli',
      fingerprint,
    );

    recordAttempt(fields.agentName);

    const urls = resolveRegistrationUrls(result);

    clearScreen();
    renderSuccess({
      certificateId: result.certificateId,
      domain: result.domain,
      email: fields.email,
      ...urls,
      queueNumber: result.queueNumber,
    });

    // ASCII text card — paste in READMEs or memory files
    write('');
    write(generateTextCard({
      agentName: result.agentName,
      domain: result.domain,
      certificateId: result.certificateId,
      accountType: 'Agent',
      viewUrl: urls.viewUrl,
    }));
    write('');
  } catch (err) {
    clearScreen();
    renderError((err as Error).message);
    process.exit(1);
  }
}

// ─── Interactive registration ───────────────────────────────

async function interactiveRegister(): Promise<void> {
  // Rate limit check
  const limit = checkRateLimit();
  if (!limit.allowed) {
    renderRateLimit(limit);
    process.exit(1);
  }

  await showBootScreen();
  const fields = await collectFields();
  await confirmAndSubmit(fields);
}

// ─── Non-interactive registration ───────────────────────────

function parseFlags(argv: string[]): Record<string, string | true> {
  const flags: Record<string, string | true> = {};
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      continue;
    }

    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      flags[arg.slice(2)] = next;
      i += 1;
    } else {
      flags[arg.slice(2)] = true;
    }
  }
  return flags;
}

async function nonInteractiveRegister(flags: Record<string, string | true>): Promise<void> {
  const nameFlag = stringFlag(flags.name);
  const email = stringFlag(flags.email);
  const operatorFlag = stringFlag(flags.operator);
  const descriptionFlag = stringFlag(flags.description);
  const agentName = normalizeAgentName(nameFlag ?? '');
  const operatorName = operatorFlag?.trim() ?? '';
  const description = descriptionFlag?.trim() || undefined;

  if (!agentName || !email || !operatorName) {
    process.stderr.write(
      `\n  ${color.red('Usage:')} dmv-agent register --name <agent> --email <email> --operator <name>\n` +
      `  ${color.greenDim('Optional:')} --description <text>\n\n`
    );
    process.exit(1);
  }

  const nameErr = validateAgentName(agentName);
  if (nameErr) {
    validationError(`agent name: ${nameErr}`);
    process.exit(1);
  }

  const emailErr = validateEmail(email);
  if (emailErr) {
    validationError(`email: ${emailErr}`);
    process.exit(1);
  }

  const operatorErr = validateOperatorName(operatorName);
  if (operatorErr) {
    validationError(`operatorName: ${operatorErr}`);
    process.exit(1);
  }

  const validationErrors = validateAgentRegistration({
    agentName,
    email,
    operatorName,
    description,
  });
  if (validationErrors.length > 0) {
    for (const err of validationErrors) {
      validationError(`${err.field}: ${err.message}`);
    }
    process.exit(1);
  }

  // Rate limit check
  const limit = checkRateLimit();
  if (!limit.allowed) {
    renderRateLimit(limit);
    process.exit(1);
  }

  process.stderr.write(`\n  ${color.green('Pre-registering')} ${color.greenBold(agentName + '.agent')}...\n`);

  try {
    const fingerprint = getMachineFingerprint();
    const result = await registerAgent(
      { agentName, email, operatorName, description },
      'cli',
      fingerprint,
    );

    recordAttempt(agentName);

    const urls = resolveRegistrationUrls(result);

    renderSuccess({
      certificateId: result.certificateId,
      domain: result.domain,
      email,
      ...urls,
      queueNumber: result.queueNumber,
    });

    // ASCII text card — paste in READMEs or memory files
    write('');
    write(generateTextCard({
      agentName: result.agentName,
      domain: result.domain,
      certificateId: result.certificateId,
      accountType: 'Agent',
      viewUrl: urls.viewUrl,
    }));
    write('');
  } catch (err) {
    renderError((err as Error).message);
    process.exit(1);
  }
}

// ─── Verify command ─────────────────────────────────────────

async function verifyCommand(): Promise<void> {
  const certId = args[1];
  if (!certId) {
    process.stderr.write(`\n  ${color.red('Usage:')} dmv-agent verify <CERT-ID>\n\n`);
    process.exit(1);
  }

  const valid = verifyCertificateId(certId);
  if (valid) {
    process.stderr.write(`\n  ${color.green('✓')} Certificate ${color.greenBold(certId)} has a valid check digit.\n\n`);
  } else {
    process.stderr.write(`\n  ${color.red('✗')} Certificate ${color.red(certId)} has an invalid check digit.\n\n`);
    process.exit(1);
  }
}

// ─── Doctor command ─────────────────────────────────────────

async function doctorCommand(): Promise<void> {
  const flags = parseFlags(args);
  const result = await runDoctor({ baseUrl: stringFlag(flags['base-url']) });

  if (Object.prototype.hasOwnProperty.call(flags, 'json')) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (!result.ok) {
      process.exit(1);
    }
    return;
  }

  process.stderr.write(`\n  ${color.greenBold('DMV doctor')}: ${result.ok ? color.green('OK') : color.red('FAILED')}\n`);
  process.stderr.write(`  ${color.greenDim('Base URL:')} ${result.baseUrl}\n\n`);

  for (const check of result.checks) {
    const mark = check.status === 'pass' ? color.green('✓') : color.red('✗');
    const label = check.status === 'pass' ? color.green(check.label) : color.red(check.label);
    process.stderr.write(`  ${mark} ${label} — ${check.detail}\n`);
  }

  process.stderr.write('\n');
  if (!result.ok) {
    process.exit(1);
  }
}

function stringFlag(value: string | true | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

// ─── MCP server ─────────────────────────────────────────────

async function startMcpServer(): Promise<void> {
  await import('./mcp-server.js');
}

// ─── Main ───────────────────────────────────────────────────

async function main(): Promise<void> {
  // Ensure cursor is restored on exit
  process.on('exit', () => showCursor());
  process.on('SIGINT', () => { showCursor(); process.exit(0); });
  process.on('SIGTERM', () => { showCursor(); process.exit(0); });

  switch (command) {
    case 'register': {
      const flags = parseFlags(args);
      if (flags.name || flags.email) {
        await nonInteractiveRegister(flags);
      } else {
        await interactiveRegister();
      }
      break;
    }
    case 'verify':
      await verifyCommand();
      break;
    case 'doctor':
      await doctorCommand();
      break;
    case undefined:
    case 'serve':
      await startMcpServer();
      break;
    default:
      process.stderr.write(
        `\n  ${color.red('Unknown command:')} ${command}\n` +
        `  ${color.green('Usage:')} dmv-agent [register|verify|doctor|serve]\n\n`
      );
      process.exit(1);
  }
}

main().catch((err) => {
  showCursor();
  console.error('Fatal:', err);
  process.exit(1);
});

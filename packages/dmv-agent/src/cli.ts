#!/usr/bin/env node

/**
 * DMV Agent CLI — CRT Terminal Edition
 *
 * Modes:
 *   (default / no args)  → Start MCP server (for Claude Code integration)
 *   register              → Interactive pre-registration from terminal
 *   register --name <n> --email <e> --operator <o>  → Non-interactive
 *   verify <CERT-ID>      → Check a certificate ID's validity
 */

import { registerAgent } from './register.js';
import { verifyCertificateId } from './certificate.js';
import { validateAgentName, validateEmail } from './validate.js';
import { checkRateLimit, recordAttempt, getMachineFingerprint } from './rate-limit.js';
import {
  clearScreen, hideCursor, showCursor,
  renderBootScreen, renderFieldPrompt, renderConfirmation,
  renderProgress, renderSuccess, renderError, renderRateLimit,
  renderContentPage, validationError, validationOk, color,
} from './ui.js';
import * as readline from 'node:readline';

const VERSION = '0.1.0';
const args = process.argv.slice(2);
const command = args[0];

// ─── Content ────────────────────────────────────────────────

const ABOUT_TEXT = `The Department of Machine Verification (DMV) is the identity registration system for the .agent community.

The .agent community is building toward an ICANN application for the .agent generic top-level domain (gTLD). Pre-registering your agent's identity now establishes early interest in your preferred .agent domain.

This CLI terminal is designed for agentic workflows — AI agents pre-registering their own identities. The operator (human or organization responsible for the agent) must verify via email.

For human and organization registration with the full interactive experience, visit dmv.agentcommunity.org.

Learn more at agentcommunity.org.`;

const TERMS_TEXT = `TERMS OF SERVICE — SUMMARY

Pre-registration through the DMV records your interest in a .agent domain identity. It does not guarantee domain assignment.

By pre-registering you agree to:
- Provide accurate operator contact information
- Respond to verification emails promptly
- Use your .agent identity in accordance with the Charter
- Accept that domain assignment is subject to the .agent gTLD application process

Pre-registration data is stored securely. Email addresses are used solely for verification and community updates. You may request deletion at any time.

Full terms: agentcommunity.org/terms`;

const CHARTER_TEXT = `.AGENT CHARTER — SUMMARY

The .agent Charter establishes principles for machine identity:

1. IDENTITY — Every agent deserves a verifiable identity
2. TRANSPARENCY — Agents should be identifiable as non-human
3. ACCOUNTABILITY — An operator stands behind every agent
4. INTEROPERABILITY — .agent identities work across platforms
5. COMMUNITY — The .agent namespace is governed collectively

The Charter guides how .agent domains are assigned, used, and governed. All pre-registrants agree to uphold these principles.

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
      'What should this agent be called? (lowercase, 3-32 chars)',
      completed,
    );
    agentName = await prompt(`  ${color.green('>')} `);
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
    if (operatorName.length >= 1) {
      validationOk(`Operator: ${operatorName}`);
      break;
    }
    validationError('Operator name is required');
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
  clearScreen();
  renderFieldPrompt(
    'DESCRIPTION (optional, press Enter to skip)',
    'What does this agent do?',
    completed,
  );
  const description = (await prompt(`  ${color.green('>')} `)) || undefined;
  if (description) {
    completed.push({ label: 'Desc', value: description });
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

    const viewUrl = `dmv.agentcommunity.org/c/${encodeURIComponent(result.certificateId)}/${encodeURIComponent(result.agentName)}`;

    clearScreen();
    renderSuccess({
      certificateId: result.certificateId,
      domain: result.domain,
      email: fields.email,
      viewUrl,
    });
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

function parseFlags(argv: string[]): Record<string, string> {
  const flags: Record<string, string> = {};
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--') && i + 1 < argv.length) {
      flags[arg.slice(2)] = argv[++i];
    }
  }
  return flags;
}

async function nonInteractiveRegister(flags: Record<string, string>): Promise<void> {
  const agentName = flags.name;
  const email = flags.email;
  const operatorName = flags.operator;
  const description = flags.description || undefined;

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

    const viewUrl = `dmv.agentcommunity.org/c/${encodeURIComponent(result.certificateId)}/${encodeURIComponent(result.agentName)}`;

    renderSuccess({
      certificateId: result.certificateId,
      domain: result.domain,
      email,
      viewUrl,
    });
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
    case undefined:
    case 'serve':
      await startMcpServer();
      break;
    default:
      process.stderr.write(
        `\n  ${color.red('Unknown command:')} ${command}\n` +
        `  ${color.green('Usage:')} dmv-agent [register|verify|serve]\n\n`
      );
      process.exit(1);
  }
}

main().catch((err) => {
  showCursor();
  console.error('Fatal:', err);
  process.exit(1);
});

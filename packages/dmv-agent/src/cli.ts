#!/usr/bin/env node

/**
 * DMV Agent CLI
 *
 * Modes:
 *   (default / no args)  → Start MCP server (for Claude Code integration)
 *   register              → Interactive registration from terminal
 *   verify <CERT-ID>      → Check a certificate ID's validity
 */

import { registerAgent } from './register.js';
import { verifyCertificateId } from './certificate.js';
import { validateAgentName, validateEmail } from './validate.js';
import * as readline from 'node:readline';

const args = process.argv.slice(2);
const command = args[0];

async function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stderr, // stderr so stdout stays clean for MCP
  });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function interactiveRegister() {
  console.error('\n  DMV — Department of Machine Verification');
  console.error('  Agent Identity Registration\n');

  // Agent name
  let agentName = '';
  while (true) {
    agentName = await prompt('  Agent name (lowercase, 3-32 chars): ');
    const err = validateAgentName(agentName);
    if (!err) break;
    console.error(`  ✗ ${err}`);
  }

  // Email
  let email = '';
  while (true) {
    email = await prompt('  Email for verification: ');
    const err = validateEmail(email);
    if (!err) break;
    console.error(`  ✗ ${err}`);
  }

  // Optional fields
  const operatorName =
    (await prompt('  Operator name (optional, press Enter to skip): ')) ||
    undefined;
  const description =
    (await prompt('  Agent description (optional, press Enter to skip): ')) ||
    undefined;

  console.error('\n  Registering...');

  try {
    const result = await registerAgent(
      { agentName, email, operatorName, description },
      'cli',
    );
    console.error(`\n  ✓ ${result.message}`);
    console.error(`  Certificate: ${result.certificateId}`);
    console.error(`  Domain:      ${result.domain}`);
    console.error(
      `  View:        dmv.agentcommunity.org/#/${encodeURIComponent(result.certificateId)}/${encodeURIComponent(result.agentName)}\n`,
    );
  } catch (err) {
    console.error(`\n  ✗ ${(err as Error).message}\n`);
    process.exit(1);
  }
}

async function verifyCommand() {
  const certId = args[1];
  if (!certId) {
    console.error('Usage: dmv-agent verify <CERT-ID>');
    process.exit(1);
  }

  const valid = verifyCertificateId(certId);
  if (valid) {
    console.log(`✓ Certificate ${certId} has a valid check digit.`);
  } else {
    console.log(`✗ Certificate ${certId} has an invalid check digit.`);
    process.exit(1);
  }
}

async function startMcpServer() {
  // Dynamic import so CLI commands don't pay MCP startup cost
  await import('./mcp-server.js');
}

async function main() {
  switch (command) {
    case 'register':
      await interactiveRegister();
      break;
    case 'verify':
      await verifyCommand();
      break;
    case undefined:
    case 'serve':
      await startMcpServer();
      break;
    default:
      console.error(`Unknown command: ${command}`);
      console.error('Usage: dmv-agent [register|verify|serve]');
      process.exit(1);
  }
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});

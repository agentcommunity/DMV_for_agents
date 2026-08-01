#!/usr/bin/env node

/**
 * DMV Agent Registration — MCP Server
 *
 * Exposes a `register_agent` tool that AI agents can call
 * to pre-register their .agent identity at the DMV.
 *
 * Usage with Claude Code:
 *   Add to .claude/settings.json:
 *   {
 *     "mcpServers": {
 *       "dmv": {
 *         "command": "npx",
 *         "args": ["@agentcommunity/dmv-agent"]
 *       }
 *     }
 *   }
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { registerAgent } from './register.js';
import { verifyCertificate, formatVerificationResult } from './lookup.js';
import { runDoctor } from './doctor.js';
import { packageVersion } from './package-info.js';
import { resolveRegistrationUrls } from './urls.js';
import { normalizeAgentName, validateOperatorName } from './validate.js';
import { checkRateLimit, recordAttempt, getMachineFingerprint } from './rate-limit.js';

const server = new Server(
  {
    name: 'dmv-agent',
    version: packageVersion,
  },
  {
    capabilities: {
      tools: {},
    },
  },
);

// List available tools
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'register_agent',
      description:
        'Pre-register an .agent identity at the Department of Machine Verification (DMV). ' +
        'Issues a content-addressed certificate ID. A verification email will be sent to the ' +
        'provided email address which must be clicked to complete verification.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          agent_name: {
            type: 'string',
            description:
              'The desired agent name (without .agent suffix). ' +
              'Lowercase alphanumeric, hyphens allowed. 3-63 chars. ' +
              'Example: "my-assistant"',
          },
          email: {
            type: 'string',
            description:
              'Email address for verification. A confirmation link will be sent.',
          },
          operator_name: {
            type: 'string',
            description:
              'Name of the person or organization operating this agent. Required.',
          },
          description: {
            type: 'string',
            description:
              'Optional: Brief description of what this agent does.',
          },
        },
        required: ['agent_name', 'email', 'operator_name'],
      },
    },
    {
      name: 'dmv_doctor',
      description:
        'Run a read-only DMV readiness check before registration. ' +
        'Checks the Worker health endpoint, card PNG rendering, badge SVG rendering, ' +
        'and invalid-payload /api/register validation without submitting a valid registration.',
      inputSchema: {
        type: 'object' as const,
        properties: {},
      },
    },
    {
      name: 'verify_certificate',
      description:
        'Verify a DMV certificate ID. By default this performs a LIVE issuance check ' +
        'against the public DMV Worker (GET /api/lookup, rate-limited ~30 requests per ' +
        '60s per IP): it confirms whether a matching registration row actually exists in ' +
        'the database, not merely whether the ID is well-formed. "issued: true" means a ' +
        'registration row exists — it does NOT mean the operator completed email ' +
        'verification or that DNS delegation exists. Network errors, timeouts, unexpected ' +
        'HTTP statuses, and malformed/partial/inconsistent JSON cause this tool to ' +
        'fall back to an offline check-digit-only validation and clearly ' +
        'labels the result as format-only — a network failure is never reported as ' +
        '"not issued". An exact typed HTTP 503 unavailable response and a valid HTTP 429 ' +
        'remain live but inconclusive; neither falls back or becomes a negative result. ' +
        'Set format_only: true to skip the network call entirely and only ' +
        'validate the Luhn mod-36 check digit offline (fast, no rate limit, but does not ' +
        'confirm the certificate exists).',
      inputSchema: {
        type: 'object' as const,
        properties: {
          certificate_id: {
            type: 'string',
            description: 'The certificate ID to verify (e.g. NOVA-7F3-AB2C)',
          },
          format_only: {
            type: 'boolean',
            description:
              'If true, skip the live database lookup and only check the offline Luhn ' +
              'check digit (no network call, does not confirm issuance). Defaults to false.',
          },
        },
        required: ['certificate_id'],
      },
    },
  ],
}));

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  if (name === 'register_agent') {
    const agentName = normalizeAgentName((args?.agent_name as string) || '');
    const email = (args?.email as string) || '';
    const operatorName = (args?.operator_name as string) || '';
    const description = (args?.description as string) || undefined;

    try {
      const operatorErr = validateOperatorName(operatorName);
      if (operatorErr) {
        return {
          content: [{ type: 'text' as const, text: `Registration failed: operator_name: ${operatorErr}` }],
          isError: true,
        };
      }

      // Client-side rate limiting (same as CLI)
      const rateStatus = checkRateLimit();
      if (!rateStatus.allowed) {
        return {
          content: [{ type: 'text' as const, text: `Rate limited: ${rateStatus.used}/${rateStatus.max} registrations used in the last 24h. Try again in ${rateStatus.retryIn}.` }],
          isError: true,
        };
      }

      const fingerprint = getMachineFingerprint();
      const result = await registerAgent(
        { agentName, email, operatorName, description },
        'mcp',
        fingerprint,
      );

      // Record successful attempt
      recordAttempt(agentName);
      const urls = resolveRegistrationUrls(result);

      return {
        content: [
          {
            type: 'text' as const,
            text: [
              `✓ Agent pre-registration recorded.`,
              ``,
              `  Agent:       ${result.domain}`,
              `  Certificate: ${result.certificateId}`,
              `  Status:      Pre-registered`,
              ``,
              `  A verification email will be sent to ${email}.`,
              `  Click the link in the email to complete verification.`,
              ``,
              `  View: ${urls.permalinkUrl}`,
              `  Badge: ${urls.badgeUrl}`,
              `  Card badge: ${urls.badgeCardUrl}`,
            ].join('\n'),
          },
        ],
      };
    } catch (err) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `Registration failed: ${(err as Error).message}`,
          },
        ],
        isError: true,
      };
    }
  }

  if (name === 'dmv_doctor') {
    const result = await runDoctor();
    const lines = [
      `DMV doctor: ${result.ok ? 'OK' : 'FAILED'}`,
      `Base URL: ${result.baseUrl}`,
      ``,
      ...result.checks.map((check) =>
        `${check.status === 'pass' ? '✓' : '✗'} ${check.label}: ${check.detail}`,
      ),
    ];

    return {
      content: [{ type: 'text' as const, text: lines.join('\n') }],
      isError: !result.ok,
    };
  }

  if (name === 'verify_certificate') {
    const certId = (args?.certificate_id as string) || '';
    const formatOnly = args?.format_only === true;
    const baseUrl = process.env.DMV_BASE_URL;
    const result = await verifyCertificate(certId, { formatOnly, baseUrl });

    // Rate limited and "unavailable" are inconclusive, not errors — a network
    // failure or a throttled request is never reported as "not issued".
    const isError = result.rateLimited
      ? false
      : result.checkMode === 'live'
        ? result.status === 'invalid_format' || result.status === 'not_found'
        : !result.formatValid;

    return {
      content: [{ type: 'text' as const, text: formatVerificationResult(result) }],
      isError,
    };
  }

  return {
    content: [{ type: 'text' as const, text: `Unknown tool: ${name}` }],
    isError: true,
  };
});

// Start the server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error('MCP server failed to start:', err);
  process.exit(1);
});

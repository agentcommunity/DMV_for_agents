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
import { verifyCertificateId } from './certificate.js';
import { validateAgentName, validateEmail } from './validate.js';
import { checkRateLimit, recordAttempt, getMachineFingerprint } from './rate-limit.js';

const server = new Server(
  {
    name: 'dmv-agent',
    version: '0.1.0',
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
      name: 'verify_certificate',
      description:
        'Verify that a DMV certificate ID is valid (check digit passes). ' +
        'Does not check if the certificate exists in the database.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          certificate_id: {
            type: 'string',
            description: 'The certificate ID to verify (e.g. NOVA-7F3-AB2C)',
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
    const agentName = (args?.agent_name as string) || '';
    const email = (args?.email as string) || '';
    const operatorName = (args?.operator_name as string) || undefined;
    const description = (args?.description as string) || undefined;

    try {
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

      return {
        content: [
          {
            type: 'text' as const,
            text: [
              `✓ Agent registered successfully!`,
              ``,
              `  Agent:       ${result.domain}`,
              `  Certificate: ${result.certificateId}`,
              `  Status:      Pre-registered`,
              ``,
              `  A verification email will be sent to ${email}.`,
              `  Click the link in the email to complete verification.`,
              ``,
              `  View: dmv.agentcommunity.org/c/${encodeURIComponent(result.certificateId)}/${encodeURIComponent(result.agentName)}`,
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

  if (name === 'verify_certificate') {
    const certId = (args?.certificate_id as string) || '';
    const valid = verifyCertificateId(certId);

    return {
      content: [
        {
          type: 'text' as const,
          text: valid
            ? `✓ Certificate ${certId} has a valid check digit.`
            : `✗ Certificate ${certId} has an invalid check digit.`,
        },
      ],
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

# dmv-agent

Compatibility alias for the canonical [`@agentcommunity/dmv-agent`](https://www.npmjs.com/package/@agentcommunity/dmv-agent) package. New installations should use the scoped package; this wrapper preserves existing unscoped installations and is not a separate SDK or capability.

## Usage

```bash
# Register an .agent identity (interactive CRT terminal)
bunx @agentcommunity/dmv-agent register

# Non-interactive (for scripting / agentic workflows)
bunx @agentcommunity/dmv-agent register --name my-agent --email operator@example.com --operator "Operator Name"

# Verify a certificate ID offline
bunx @agentcommunity/dmv-agent verify MESA-DD6-660J --format-only

# Start the MCP server (for AI agent hosts)
bunx @agentcommunity/dmv-agent
```

## MCP server config

Add to your Claude Code or MCP host config:

```json
{
  "mcpServers": {
    "dmv": {
      "command": "bunx",
      "args": ["@agentcommunity/dmv-agent"]
    }
  }
}
```

## What is this?

This package is a thin wrapper around `@agentcommunity/dmv-agent`. It remains
for compatibility with existing installations and resolves to the same
executable capability. Use `bunx @agentcommunity/dmv-agent` in new setup and
documentation.

## What is the DMV?

The Department of Machine Verification is the identity pre-registration system for the [.agent community](https://agentcommunity.org) — a coalition applying for the proposed `.agent` top-level domain through ICANN's community application process.

Pre-registration is **non-binding** — it records interest in a `.agent` domain name but does not guarantee assignment. Certificate IDs, however, are **unique and permanent**.

For full documentation, API reference, badge embedding, and security details, see the [@agentcommunity/dmv-agent README](https://www.npmjs.com/package/@agentcommunity/dmv-agent).

## License

MIT

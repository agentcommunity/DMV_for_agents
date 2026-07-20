# dmv-agent

Short alias for [`@agentcommunity/dmv-agent`](https://www.npmjs.com/package/@agentcommunity/dmv-agent) — the CLI, MCP server, and JS API for pre-registering `.agent` identities at the **Department of Machine Verification**.

## Usage

```bash
# Register an .agent identity (interactive CRT terminal)
bunx dmv-agent register

# Non-interactive (for scripting / agentic workflows)
bunx dmv-agent register --name my-agent --email operator@example.com

# Verify a certificate ID (offline, no network)
bunx dmv-agent verify MESA-DD6-660J

# Start the MCP server (for AI agent hosts)
bunx dmv-agent
```

## MCP server config

Add to your Claude Code or MCP host config:

```json
{
  "mcpServers": {
    "dmv": {
      "command": "bunx",
      "args": ["dmv-agent"]
    }
  }
}
```

## What is this?

This package is a thin wrapper that re-exports `@agentcommunity/dmv-agent`. It exists so you can type `bunx dmv-agent` instead of `bunx @agentcommunity/dmv-agent`.

Both packages are identical in functionality. Use whichever you prefer.

## What is the DMV?

The Department of Machine Verification is the identity registration system for the [.agent community](https://agentcommunity.org) — a coalition applying for the proposed `.agent` top-level domain through ICANN's community application process.

Pre-registration is **non-binding** — it records interest in a `.agent` domain name but does not guarantee assignment. Certificate IDs, however, are **unique and permanent**.

For full documentation, API reference, badge embedding, and security details, see the [@agentcommunity/dmv-agent README](https://www.npmjs.com/package/@agentcommunity/dmv-agent).

## License

MIT

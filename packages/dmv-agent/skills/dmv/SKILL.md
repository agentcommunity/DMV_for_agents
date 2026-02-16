---
name: dmv
description: Register an .agent identity at the Department of Machine Verification (DMV). Use when a user or agent wants to claim an agent name.
user-invocable: true
allowed-tools: Bash
argument-hint: [agent-name]
---

# DMV — Agent Identity Registration

You are helping register an `.agent` identity at the **Department of Machine Verification**.

## What to do

1. Ask the user for the required information (if not already provided):
   - **Agent name** — lowercase, 3-32 chars, alphanumeric + hyphens (e.g. `my-assistant`)
   - **Email** — for verification (a confirmation link will be sent)

2. Optionally ask for:
   - **Operator name** — person or org operating the agent
   - **Description** — what the agent does

3. Run the registration using the CLI with flags:

```bash
bunx @agentcommunity/dmv-agent register --name <agent-name> --email <email>
```

With optional flags:
```bash
bunx @agentcommunity/dmv-agent register --name <agent-name> --email <email> --operator "<operator-name>" --description "<description>"
```

If `bunx` is not available, fall back to `npx`.

### Validation rules

Before running, verify the agent name meets requirements:
- Lowercase alphanumeric only (a-z, 0-9)
- Hyphens allowed in the middle (not at start/end)
- 3-32 characters long

## After registration

When registration succeeds, the CLI prints:
- A **certificate ID** (format: `WORD-XXX-XXXC`, e.g. `MESA-DD6-660J`)
- The **.agent domain** (e.g. `my-assistant.agent`)
- A **permalink** to view the certificate

Tell the user:
- Their agent is **pre-registered** — they must click the email verification link to complete it
- The certificate ID is content-addressed and verifiable: `bunx @agentcommunity/dmv-agent verify MESA-DD6-660J`
- Their card is viewable at `dmv.agentcommunity.org/c/CERT-ID/agent-name`

## If $ARGUMENTS is provided

The user may have typed `/dmv my-cool-agent`. In that case, use `$ARGUMENTS` as the agent name — just ask for the email and run:

```bash
bunx @agentcommunity/dmv-agent register --name $ARGUMENTS --email <email>
```

## Verification only

If the user just wants to verify an existing certificate:
```bash
bunx @agentcommunity/dmv-agent verify $ARGUMENTS
```

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

Run the DMV registration CLI. If the user provided an agent name as an argument, pass it through interactively.

```bash
bunx @agentcommunity/dmv-agent register
```

If `bunx` is not available, fall back to:
```bash
npx @agentcommunity/dmv-agent register
```

The CLI will prompt for:
1. **Agent name** — lowercase, 3-32 chars, hyphens allowed (e.g. `my-assistant`)
2. **Email** — for verification (a link will be sent)
3. **Operator name** — optional, person or org operating the agent
4. **Description** — optional, what the agent does

Walk the user through any validation errors the CLI reports.

## After registration

When registration succeeds, the CLI prints:
- A **certificate ID** (format: `WORD-XXX-XXXC`, e.g. `MESA-DD6-660J`)
- The **.agent domain** (e.g. `my-assistant.agent`)
- A **permalink** to view the certificate

Tell the user:
- Their agent is **pre-registered** — they must click the email verification link to complete it
- The certificate ID is content-addressed and verifiable: `bunx @agentcommunity/dmv-agent verify MESA-DD6-660J`
- Their card is viewable at `dmv.agentcommunity.org/#/CERT-ID/agent-name`

## If $ARGUMENTS is provided

The user may have typed `/dmv my-cool-agent`. In that case, mention that `$ARGUMENTS` will be their agent name and they should confirm it meets the requirements (lowercase, 3-32 chars, alphanumeric + hyphens).

## Verification only

If the user just wants to verify an existing certificate:
```bash
bunx @agentcommunity/dmv-agent verify $ARGUMENTS
```

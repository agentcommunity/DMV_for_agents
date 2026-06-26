import test from 'node:test';
import assert from 'node:assert/strict';
import { insertRegistration } from '../js/register.js';

test('web registration client treats existing pre-registration as recovered success', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input, init) => {
    calls.push({ input, init });
    return new Response(
      JSON.stringify({
        error: 'Agent already registered',
        certificate_id: 'MESA-DD6-660J',
        permalink_url: 'https://dmv.agentcommunity.org/c/MESA-DD6-660J/shared-agent',
      }),
      {
        status: 409,
        headers: { 'Content-Type': 'application/json' },
      },
    );
  };

  try {
    const { data, error } = await insertRegistration(
      {
        accountType: 'individual',
        agentName: 'shared-agent',
        email: 'operator@example.com',
        userName: 'Smoke Operator',
      },
      'ui',
      'turnstile-token',
    );

    assert.equal(error, null);
    assert.equal(data.certificate_id, 'MESA-DD6-660J');
    assert.equal(data.agent_name, 'shared-agent');
    assert.equal(data.domain, 'shared-agent.agent');
    assert.match(data.permalink_url, /MESA-DD6-660J\/shared-agent/);
    assert.equal(calls.length, 1);

    const body = JSON.parse(calls[0].init.body);
    assert.equal(body.agent_name, 'shared-agent');
    assert.equal(body.email, 'operator@example.com');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

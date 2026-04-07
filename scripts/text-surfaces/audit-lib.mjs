import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();

export const CLAIMS = [
  {
    id: 'pre_registration',
    label: 'Mentions pre-registration',
    pattern: /\bpre-register|\bpre-registr/i,
  },
  {
    id: 'non_binding',
    label: 'Clarifies non-binding / no assignment guarantee',
    pattern: /(non-binding|not a guarantee|does not guarantee|doesn['’]t guarantee|records? interest|subject to .*assignment|assignment happens later|domain assignment happens later|pre-registration model)/i,
  },
  {
    id: 'verification_email',
    label: 'Mentions verification email requirement',
    pattern: /(verification email|verify to complete|must click|magic link|check .*email|verify via email)/i,
  },
  {
    id: 'certificate_id',
    label: 'Mentions certificate ID',
    pattern: /(certificate[_ -]?id|certificate id|certificate:|cert[- ]?id)/i,
  },
  {
    id: 'permalink',
    label: 'Mentions certificate permalink',
    pattern: /dmv\.agentcommunity\.org\/c\//i,
  },
  {
    id: 'badge',
    label: 'Mentions badge',
    pattern: /(dmv\.agentcommunity\.org\/badge|\bbadge\b)/i,
  },
  {
    id: 'share',
    label: 'Mentions share/invite behavior',
    pattern: /(share|tweet|invite agents|spread the word|get yours)/i,
  },
  {
    id: 'aid',
    label: 'Mentions AID / DNS identity',
    pattern: /\bAID\b|_agent\.[a-z0-9-]+\.agent/i,
  },
  {
    id: 'audience_human_org',
    label: 'Mentions humans/org audience',
    pattern: /(humans? ?& ?organizations?|human and organization|individual|organization)/i,
  },
  {
    id: 'audience_agent',
    label: 'Mentions agent audience',
    pattern: /(AI agents?|agentic workflows|this terminal is for ai agents|autonomous agents|register_agent)/i,
  },
  {
    id: 'terms_charter',
    label: 'Mentions terms/charter',
    pattern: /(terms|charter)/i,
  },
];

export const SURFACES = [
  {
    id: 'web_crt',
    label: 'Web CRT terminal flow',
    audience: 'human/org',
    flow: 'web-ui',
    files: ['js/CRTTerminal.js'],
  },
  {
    id: 'web_share',
    label: 'Web share + permalink UX',
    audience: 'mixed',
    flow: 'web-ui',
    files: ['js/app.js'],
  },
  {
    id: 'web_card_client',
    label: 'Browser card text renderer',
    audience: 'mixed',
    flow: 'card',
    files: ['js/card-draw.js'],
  },
  {
    id: 'web_card_server',
    label: 'Server card text renderer',
    audience: 'mixed',
    flow: 'card',
    files: ['container/src/card-renderer.js'],
  },
  {
    id: 'web_metadata',
    label: 'Web metadata / crawler OG injection',
    audience: 'crawler',
    flow: 'metadata',
    files: ['index.html', 'worker/index.ts'],
  },
  {
    id: 'root_readme',
    label: 'Root README',
    audience: 'mixed',
    flow: 'docs',
    files: ['README.md'],
  },
  {
    id: 'llms_manifest',
    label: 'LLM manifest',
    audience: 'agent',
    flow: 'docs',
    files: ['llms.txt'],
  },
  {
    id: 'cli_runtime',
    label: 'Agent CLI runtime UX',
    audience: 'agent',
    flow: 'cli',
    files: ['packages/dmv-agent/src/cli.ts', 'packages/dmv-agent/src/ui.ts'],
  },
  {
    id: 'mcp_runtime',
    label: 'MCP server tool descriptions',
    audience: 'agent',
    flow: 'mcp',
    files: ['packages/dmv-agent/src/mcp-server.ts'],
  },
  {
    id: 'agent_readme',
    label: 'Agent package README',
    audience: 'agent',
    flow: 'docs',
    files: ['packages/dmv-agent/README.md'],
  },
  {
    id: 'register_api',
    label: 'Registration API response text',
    audience: 'all',
    flow: 'api',
    files: ['supabase/functions/register-agent/index.ts'],
  },
  {
    id: 'badge_api',
    label: 'Badge API text',
    audience: 'all',
    flow: 'api',
    files: ['supabase/functions/badge/index.ts'],
  },
];

// Product decisions intentionally allowing some text/state divergence.
const ACCEPTED_EXCEPTIONS = {
  'web-crt-email-reminder-gap': {
    rationale:
      'Web CRT flow relies on follow-up email sequence; avoid overloading CRT completion copy.',
  },
  'status-language-drift': {
    rationale:
      'Card remains visually "VERIFIED" by design; DB pending status is internal until email verification.',
  },
};

function readUtf8(relPath) {
  const absPath = path.resolve(ROOT, relPath);
  try {
    return fs.readFileSync(absPath, 'utf8');
  } catch {
    return '';
  }
}

function findEvidenceInText(text, pattern, maxMatches = 2) {
  const hits = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (pattern.test(lines[i])) {
      hits.push({ line: i + 1, text: lines[i].trim() });
      if (hits.length >= maxMatches) break;
    }
  }
  return hits;
}

function findPermalinkEvidence(text, maxMatches = 2) {
  const directHits = findEvidenceInText(text, CLAIMS.find((claim) => claim.id === 'permalink').pattern, maxMatches);
  if (directHits.length > 0) return directHits;

  const lines = text.split(/\r?\n/);
  const inferredPatterns = [
    /function buildPermalinkUrl\(/,
    /new URL\(`\/c\/\$\{encodeURIComponent\(certId\)\}\/\$\{name\}`,\s*CANONICAL_ORIGIN\)/,
    /history\.replaceState\(null,\s*'',\s*`\/c\/\$\{encodeURIComponent\(certificateId\)\}\/\$\{name\}`\)/,
  ];

  const hits = [];
  for (let i = 0; i < lines.length; i++) {
    if (inferredPatterns.some((pattern) => pattern.test(lines[i]))) {
      hits.push({ line: i + 1, text: lines[i].trim() });
      if (hits.length >= maxMatches) break;
    }
  }
  return hits;
}

function analyzeSurface(surface) {
  const files = surface.files.map((file) => {
    const content = readUtf8(file);
    return { path: file, content };
  });
  const combinedText = files.map((f) => f.content).join('\n');
  const claims = {};

  for (const claim of CLAIMS) {
    const perFileEvidence = [];
    let found = false;

    for (const file of files) {
      const evidence = claim.id === 'permalink'
        ? findPermalinkEvidence(file.content, 1)
        : findEvidenceInText(file.content, claim.pattern, 1);
      if (evidence.length > 0) {
        found = true;
        perFileEvidence.push({
          file: file.path,
          line: evidence[0].line,
          text: evidence[0].text,
        });
      }
    }

    claims[claim.id] = {
      found,
      evidence: perFileEvidence.slice(0, 2),
    };
  }

  return {
    ...surface,
    claims,
    combinedText,
    filesLoaded: files.filter((f) => Boolean(f.content)).map((f) => f.path),
    missingFiles: files.filter((f) => !f.content).map((f) => f.path),
  };
}

function extractCardFieldLabels(text) {
  const set = new Set();
  const rx = /drawField\('([A-Z]+)'/g;
  let match;
  while ((match = rx.exec(text)) !== null) {
    set.add(match[1]);
  }
  return [...set].sort();
}

function collectCoverage(surfaces) {
  const coverage = {};
  for (const claim of CLAIMS) {
    const presentOn = [];
    const missingOn = [];
    for (const surface of surfaces) {
      if (surface.claims[claim.id].found) presentOn.push(surface.id);
      else missingOn.push(surface.id);
    }
    coverage[claim.id] = {
      label: claim.label,
      presentCount: presentOn.length,
      missingCount: missingOn.length,
      presentOn,
      missingOn,
    };
  }
  return coverage;
}

function evaluateRules(surfacesById) {
  const errors = [];
  const warnings = [];
  const accepted = [];

  const criticalRules = [
    {
      id: 'docs-non-binding',
      description: 'Core docs must state that pre-registration is non-binding.',
      claim: 'non_binding',
      surfaces: ['root_readme', 'agent_readme', 'llms_manifest'],
    },
    {
      id: 'agent-flows-email-verification',
      description: 'Agent-facing runtime surfaces must mention email verification.',
      claim: 'verification_email',
      surfaces: ['cli_runtime', 'mcp_runtime', 'register_api'],
    },
    {
      id: 'share-surfaces-permalink',
      description: 'Share surfaces must include the certificate permalink format.',
      claim: 'permalink',
      surfaces: ['web_share', 'cli_runtime', 'agent_readme'],
    },
  ];

  for (const rule of criticalRules) {
    const missing = rule.surfaces.filter(
      (id) => !surfacesById[id]?.claims?.[rule.claim]?.found,
    );
    if (missing.length > 0) {
      errors.push({
        id: rule.id,
        description: rule.description,
        missingSurfaces: missing,
      });
    }
  }

  const clientCardFields = extractCardFieldLabels(surfacesById.web_card_client?.combinedText || '');
  const serverCardFields = extractCardFieldLabels(surfacesById.web_card_server?.combinedText || '');
  const missingInServer = clientCardFields.filter((f) => !serverCardFields.includes(f));
  const missingInClient = serverCardFields.filter((f) => !clientCardFields.includes(f));
  if (missingInServer.length > 0 || missingInClient.length > 0) {
    errors.push({
      id: 'card-field-parity',
      description: 'Client and server card renderers should expose the same field labels.',
      missingInServer,
      missingInClient,
    });
  }

  if (
    !surfacesById.web_crt?.claims?.verification_email?.found &&
    surfacesById.cli_runtime?.claims?.verification_email?.found
  ) {
    const warning = {
      id: 'web-crt-email-reminder-gap',
      description:
        'Web CRT flow appears to lack explicit email-verification reminder while agent CLI includes one.',
      surfaces: ['web_crt', 'cli_runtime'],
    };
    if (ACCEPTED_EXCEPTIONS[warning.id]) {
      accepted.push({ ...warning, rationale: ACCEPTED_EXCEPTIONS[warning.id].rationale });
    } else {
      warnings.push(warning);
    }
  }

  if (
    /provisional_dmv/.test(surfacesById.register_api?.combinedText || '') &&
    /VERIFIED/.test(surfacesById.web_card_client?.combinedText || '')
  ) {
    const warning = {
      id: 'status-language-drift',
      description:
        'Registration API persists pending status while card renderer displays VERIFIED language.',
      surfaces: ['register_api', 'web_card_client', 'web_card_server'],
    };
    if (ACCEPTED_EXCEPTIONS[warning.id]) {
      accepted.push({ ...warning, rationale: ACCEPTED_EXCEPTIONS[warning.id].rationale });
    } else {
      warnings.push(warning);
    }
  }

  return {
    errors,
    warnings,
    accepted,
    cardFieldParity: {
      client: clientCardFields,
      server: serverCardFields,
      matches: missingInServer.length === 0 && missingInClient.length === 0,
    },
  };
}

export function runAudit() {
  const analyzedSurfaces = SURFACES.map(analyzeSurface);
  const surfacesById = Object.fromEntries(analyzedSurfaces.map((s) => [s.id, s]));
  const coverage = collectCoverage(analyzedSurfaces);
  const checks = evaluateRules(surfacesById);

  return {
    generatedAt: new Date().toISOString(),
    root: ROOT,
    claims: CLAIMS.map(({ id, label }) => ({ id, label })),
    surfaces: analyzedSurfaces,
    coverage,
    checks,
    summary: {
      surfaces: analyzedSurfaces.length,
      claims: CLAIMS.length,
      errors: checks.errors.length,
      warnings: checks.warnings.length,
      accepted: checks.accepted.length,
    },
  };
}

function icon(found) {
  return found ? 'Y' : '-';
}

function claimList(surface) {
  return CLAIMS.map((c) => `${c.id}:${icon(surface.claims[c.id].found)}`).join(' ');
}

export function formatAuditReport(report) {
  const lines = [];
  lines.push('DMV Text Surface Audit');
  lines.push(`Generated: ${report.generatedAt}`);
  lines.push(`Root: ${report.root}`);
  lines.push('');
  lines.push(`Summary: ${report.summary.surfaces} surfaces, ${report.summary.claims} claims, ${report.summary.errors} errors, ${report.summary.warnings} warnings, ${report.summary.accepted} accepted exceptions`);
  lines.push('');
  lines.push('Surfaces:');
  for (const surface of report.surfaces) {
    lines.push(`- ${surface.id} (${surface.label})`);
    lines.push(`  audience=${surface.audience} flow=${surface.flow}`);
    lines.push(`  files=${surface.files.join(', ')}`);
    lines.push(`  claims=${claimList(surface)}`);
    if (surface.missingFiles.length > 0) {
      lines.push(`  missing_files=${surface.missingFiles.join(', ')}`);
    }
  }
  lines.push('');
  lines.push('Checks:');
  if (report.checks.errors.length === 0) {
    lines.push('- errors: none');
  } else {
    for (const error of report.checks.errors) {
      lines.push(`- error:${error.id} ${error.description}`);
      if (error.missingSurfaces?.length) lines.push(`  missing=${error.missingSurfaces.join(', ')}`);
      if (error.missingInServer?.length) lines.push(`  missing_in_server=${error.missingInServer.join(', ')}`);
      if (error.missingInClient?.length) lines.push(`  missing_in_client=${error.missingInClient.join(', ')}`);
    }
  }
  if (report.checks.warnings.length === 0) {
    lines.push('- warnings: none');
  } else {
    for (const warning of report.checks.warnings) {
      lines.push(`- warning:${warning.id} ${warning.description}`);
      if (warning.surfaces?.length) lines.push(`  surfaces=${warning.surfaces.join(', ')}`);
    }
  }
  if (report.checks.accepted.length === 0) {
    lines.push('- accepted: none');
  } else {
    for (const item of report.checks.accepted) {
      lines.push(`- accepted:${item.id} ${item.description}`);
      if (item.rationale) lines.push(`  rationale=${item.rationale}`);
      if (item.surfaces?.length) lines.push(`  surfaces=${item.surfaces.join(', ')}`);
    }
  }
  lines.push('');
  lines.push('Card Field Parity:');
  lines.push(`- matches=${report.checks.cardFieldParity.matches}`);
  lines.push(`- client=${report.checks.cardFieldParity.client.join(', ')}`);
  lines.push(`- server=${report.checks.cardFieldParity.server.join(', ')}`);
  return lines.join('\n');
}

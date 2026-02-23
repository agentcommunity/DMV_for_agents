#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { formatAuditReport, runAudit } from './audit-lib.mjs';

function parseArgs(argv) {
  const args = { json: false, strict: false, out: null };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === '--json') args.json = true;
    else if (token === '--strict') args.strict = true;
    else if (token === '--out' && argv[i + 1]) args.out = argv[++i];
    else if (token.startsWith('--out=')) args.out = token.slice('--out='.length);
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const report = runAudit();
const rendered = args.json ? JSON.stringify(report, null, 2) : formatAuditReport(report);

if (args.out) {
  const target = path.resolve(process.cwd(), args.out);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, rendered + '\n', 'utf8');
  console.log(`Wrote audit report to ${target}`);
} else {
  console.log(rendered);
}

if (args.strict && report.checks.errors.length > 0) {
  process.exitCode = 1;
}

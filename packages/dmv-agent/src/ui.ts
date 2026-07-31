/**
 * CRT Terminal UI renderer for the CLI.
 * ASCII art frame, ANSI colors, box drawing.
 * Zero dependencies — raw ANSI escape codes only.
 */

// ─── ANSI helpers ────────────────────────────────────────────

const ESC = '\x1b[';
const RESET = `${ESC}0m`;
const BOLD = `${ESC}1m`;
const DIM = `${ESC}2m`;
const GREEN = `${ESC}38;2;51;255;136m`;      // #33ff88
const GREEN_DIM = `${ESC}38;2;30;140;70m`;    // dimmed green
const RED = `${ESC}38;2;255;80;80m`;           // error red
const AMBER = `${ESC}38;2;255;170;51m`;        // #ffaa33
const WHITE = `${ESC}38;2;220;220;220m`;
const GRAY = `${ESC}38;2;100;100;100m`;
const CLEAR_SCREEN = `${ESC}2J${ESC}H`;
const HIDE_CURSOR = `${ESC}?25l`;
const SHOW_CURSOR = `${ESC}?25h`;

export const color = {
  green: (s: string) => `${GREEN}${s}${RESET}`,
  greenBold: (s: string) => `${GREEN}${BOLD}${s}${RESET}`,
  greenDim: (s: string) => `${GREEN_DIM}${s}${RESET}`,
  red: (s: string) => `${RED}${s}${RESET}`,
  amber: (s: string) => `${AMBER}${s}${RESET}`,
  white: (s: string) => `${WHITE}${s}${RESET}`,
  gray: (s: string) => `${GRAY}${s}${RESET}`,
  dim: (s: string) => `${DIM}${s}${RESET}`,
  bold: (s: string) => `${BOLD}${s}${RESET}`,
  reset: RESET,
};

// ─── Frame geometry ──────────────────────────────────────────

// Inner content width (characters between the frame borders)
const INNER_W = 60;
// Total frame width = 2 (outer border) + 2 (scanline) + 2 (space) + INNER_W + 2 (space) + 2 (scanline) + 2 (outer border) - overlaps
// Simplified: outer box + scanline padding + content
const SCAN = '░';

export function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

function visibleLength(s: string): number {
  return stripAnsi(s).length;
}

function padRight(s: string, width: number): string {
  const vis = visibleLength(s);
  if (vis >= width) return s;
  return s + ' '.repeat(width - vis);
}

function centerText(s: string, width: number): string {
  const vis = visibleLength(s);
  if (vis >= width) return s;
  const left = Math.floor((width - vis) / 2);
  const right = width - vis - left;
  return ' '.repeat(left) + s + ' '.repeat(right);
}

// ─── Frame rendering ─────────────────────────────────────────

function frameLine(content: string): string {
  const padded = padRight(content, INNER_W);
  return color.greenDim('│' + SCAN) + color.green('  ' + padded + '  ') + color.greenDim(SCAN + '│');
}

function frameLineRaw(content: string): string {
  // Content already has ANSI codes — just pad to width
  const padded = padRight(content, INNER_W);
  return color.greenDim('│' + SCAN) + '  ' + padded + '  ' + color.greenDim(SCAN + '│');
}

function frameEmpty(): string {
  return frameLine('');
}

function frameTop(): string {
  const inner = '░'.repeat(INNER_W + 4);
  return color.greenDim('┌─' + inner + '─┐');
}

function frameScanline(): string {
  const inner = '░'.repeat(INNER_W + 4);
  return color.greenDim('│' + inner + '│');
}

function frameBottom(): string {
  const inner = '░'.repeat(INNER_W + 4);
  return color.greenDim('└─' + inner + '─┘');
}

function frameDivider(): string {
  return frameLine('─'.repeat(INNER_W));
}

// ─── Inner box (callout) ────────────────────────────────────

function innerBoxTop(width: number): string {
  return '┌' + '─'.repeat(width - 2) + '┐';
}

function innerBoxMid(content: string, width: number): string {
  const padded = padRight(content, width - 4);
  return '│ ' + padded + ' │';
}

function innerBoxBottom(width: number): string {
  return '└' + '─'.repeat(width - 2) + '┘';
}

// ─── Public API ──────────────────────────────────────────────

export function clearScreen(): void {
  process.stderr.write(CLEAR_SCREEN);
}

export function hideCursor(): void {
  if (!process.stderr.isTTY) return;
  process.stderr.write(HIDE_CURSOR);
}

export function showCursor(): void {
  if (!process.stderr.isTTY) return;
  process.stderr.write(SHOW_CURSOR);
}

export function write(s: string): void {
  process.stderr.write(s + '\n');
}

export function writeLines(lines: string[]): void {
  process.stderr.write(lines.join('\n') + '\n');
}

/** Render the full CRT boot screen */
export function renderBootScreen(version: string): void {
  const lines: string[] = [];

  lines.push('');
  lines.push(frameTop());
  lines.push(frameScanline());
  lines.push(frameEmpty());

  // Title block
  const titleBox = [
    '╔══════════════════════════════════════════════════════════╗',
    '║  DMV — DEPARTMENT OF MACHINE VERIFICATION               ║',
    '║  Machine Identity & Pre-Registration Terminal v1.0       ║',
    '╚══════════════════════════════════════════════════════════╝',
  ];
  // Render title with precise width
  const tbW = INNER_W;
  lines.push(frameLineRaw(color.greenBold('╔' + '═'.repeat(tbW - 2) + '╗')));
  lines.push(frameLineRaw(color.greenBold(
    '║' + padRight('  DMV — DEPARTMENT OF MACHINE VERIFICATION', tbW - 2) + '║'
  )));
  lines.push(frameLineRaw(color.greenBold(
    '║' + padRight('  Machine Identity & Pre-Registration Terminal v1.0', tbW - 2) + '║'
  )));
  lines.push(frameLineRaw(color.greenBold('╚' + '═'.repeat(tbW - 2) + '╝')));

  lines.push(frameEmpty());

  // Section header
  lines.push(frameLineRaw(color.green('AGENTIC PRE-REGISTRATION')));
  lines.push(frameLineRaw(color.greenDim('────────────────────────')));
  lines.push(frameLineRaw(color.green('This terminal is for AI agents to pre-register')));
  lines.push(frameLineRaw(color.green('interest in a .agent domain identity.')));
  lines.push(frameEmpty());
  lines.push(frameLineRaw(color.green('A verification email will be sent to the operator.')));
  lines.push(frameLineRaw(color.green('Pre-registration is not a guarantee of assignment.')));

  lines.push(frameEmpty());

  // Callout box
  const cbW = INNER_W - 2;
  lines.push(frameLineRaw(color.amber('┌' + '─'.repeat(cbW - 2) + '┐')));
  lines.push(frameLineRaw(color.amber(
    '│' + padRight('  Humans & organizations: use the full terminal at', cbW - 2) + '│'
  )));
  lines.push(frameLineRaw(color.amber(
    '│' + padRight('  → dmv.agentcommunity.org', cbW - 2) + '│'
  )));
  lines.push(frameLineRaw(color.amber('└' + '─'.repeat(cbW - 2) + '┘')));

  lines.push(frameEmpty());

  // Menu
  lines.push(frameLineRaw(
    color.greenDim('[a]') + color.green(' About  ') +
    color.greenDim('[t]') + color.green(' Terms  ') +
    color.greenDim('[c]') + color.green(' Charter  ') +
    color.greenDim('[ENTER]') + color.green(' Continue')
  ));

  lines.push(frameEmpty());

  // Version
  lines.push(frameLineRaw(color.greenDim(`@agentcommunity/dmv-agent v${version}`)));

  lines.push(frameEmpty());
  lines.push(frameScanline());
  lines.push(frameBottom());
  lines.push('');

  writeLines(lines);
}

/** Render a field prompt inside the CRT frame */
export function renderFieldPrompt(
  label: string,
  hint: string,
  previousFields?: Array<{ label: string; value: string }>,
): void {
  const lines: string[] = [];

  lines.push('');
  lines.push(frameTop());
  lines.push(frameScanline());
  lines.push(frameEmpty());

  // Show previous fields as checkmarks
  if (previousFields?.length) {
    for (const f of previousFields) {
      lines.push(frameLineRaw(color.greenDim(`✓ ${f.label}: ${f.value}`)));
    }
    lines.push(frameEmpty());
  }

  // Current field
  lines.push(frameLineRaw(color.greenBold(label)));
  lines.push(frameLineRaw(color.greenDim(hint)));
  lines.push(frameEmpty());

  lines.push(frameScanline());
  lines.push(frameBottom());
  lines.push('');

  writeLines(lines);
}

/** Render the confirmation summary */
export function renderConfirmation(fields: {
  agentName: string;
  operatorName: string;
  email: string;
  description?: string;
}): void {
  const lines: string[] = [];

  lines.push('');
  lines.push(frameTop());
  lines.push(frameScanline());
  lines.push(frameEmpty());

  // Summary box
  const bW = INNER_W - 4;
  lines.push(frameLineRaw(color.green('  ┌' + '─'.repeat(bW - 2) + '┐')));
  lines.push(frameLineRaw(color.greenBold('  │' + padRight('  PRE-REGISTRATION SUMMARY', bW - 2) + '│')));
  lines.push(frameLineRaw(color.green('  │' + ' '.repeat(bW - 2) + '│')));
  lines.push(frameLineRaw(color.green('  │' + padRight(`  Agent:    ${fields.agentName}.agent`, bW - 2) + '│')));
  lines.push(frameLineRaw(color.green('  │' + padRight(`  Operator: ${fields.operatorName}`, bW - 2) + '│')));
  lines.push(frameLineRaw(color.green('  │' + padRight(`  Email:    ${fields.email}`, bW - 2) + '│')));
  if (fields.description) {
    const desc = fields.description.length > bW - 16
      ? fields.description.slice(0, bW - 19) + '...'
      : fields.description;
    lines.push(frameLineRaw(color.green('  │' + padRight(`  Desc:     ${desc}`, bW - 2) + '│')));
  }
  lines.push(frameLineRaw(color.green('  └' + '─'.repeat(bW - 2) + '┘')));

  lines.push(frameEmpty());

  // Terms notice
  lines.push(frameLineRaw(
    color.green('By continuing you accept the Terms of Service and')
  ));
  lines.push(frameLineRaw(
    color.green('.agent Charter. ') +
    color.greenDim('[t]') + color.green(' Terms  ') +
    color.greenDim('[c]') + color.green(' Charter')
  ));

  lines.push(frameEmpty());

  lines.push(frameScanline());
  lines.push(frameBottom());
  lines.push('');

  writeLines(lines);
}

/** Render a progress bar */
export async function renderProgress(label: string, durationMs: number = 1200): Promise<void> {
  const barWidth = 40;
  const steps = 20;
  const stepMs = durationMs / steps;

  for (let i = 0; i <= steps; i++) {
    const filled = Math.round((i / steps) * barWidth);
    const empty = barWidth - filled;
    const pct = Math.round((i / steps) * 100);
    const bar = '█'.repeat(filled) + '░'.repeat(empty);
    process.stderr.write(`\r  ${color.green(label)} ${color.greenBold(bar)} ${color.greenDim(pct + '%')}`);
    if (i < steps) {
      await new Promise(r => setTimeout(r, stepMs));
    }
  }
  process.stderr.write('\n');
}

/** Render success screen */
export function renderSuccess(result: {
  certificateId: string;
  domain: string;
  email: string;
  viewUrl: string;
  permalinkUrl: string;
  badgeUrl: string;
  badgeCardUrl: string;
  cardImageUrl: string;
  queueNumber?: number | null;
}): void {
  const lines: string[] = [];

  lines.push('');
  lines.push(frameTop());
  lines.push(frameScanline());
  lines.push(frameEmpty());

  lines.push(frameLineRaw(color.greenBold('✓ PRE-REGISTRATION COMPLETE')));
  lines.push(frameLineRaw(color.greenDim('───────────────────────────')));
  lines.push(frameEmpty());

  lines.push(frameLineRaw(color.green(`Certificate:  ${result.certificateId}`)));
  lines.push(frameLineRaw(color.green(`Domain:       ${result.domain}`)));
  if (result.queueNumber) {
    lines.push(frameLineRaw(color.green(`Ticket:       #${String(result.queueNumber).padStart(5, '0')}`)));
  }

  lines.push(frameEmpty());

  // View certificate — the star
  const bW = INNER_W - 4;
  lines.push(frameLineRaw(color.greenBold('VIEW YOUR CARD')));
  lines.push(frameLineRaw(color.green('Your holographic pre-registration card is ready.')));
  lines.push(frameEmpty());
  lines.push(frameLineRaw(color.greenDim('  →  ') + color.green(result.viewUrl)));

  lines.push(frameEmpty());

  // Share nudge
  lines.push(frameLineRaw(color.greenBold('SPREAD THE WORD')));
  lines.push(frameLineRaw(color.green('Share with your agent friends & partners.')));
  lines.push(frameLineRaw(color.green('Every pre-registration strengthens the community bid')));
  lines.push(frameLineRaw(color.green('for .agent — help make agentcommunity loud.')));
  lines.push(frameEmpty());
  lines.push(frameLineRaw(color.greenDim('  invite agents →  ') + color.green('bunx @agentcommunity/dmv-agent register')));
  lines.push(frameLineRaw(color.greenDim('  share card    →  ') + color.green(result.viewUrl)));

  lines.push(frameEmpty());

  // Badge
  lines.push(frameLineRaw(color.greenBold('ADD A BADGE')));
  lines.push(frameLineRaw(color.green('Show your .agent pre-registration in your README.')));
  lines.push(frameEmpty());
  lines.push(frameLineRaw(color.greenDim('  markdown →')));
  lines.push(frameLineRaw(color.green(`  [![${result.domain}](${result.badgeUrl})](${result.permalinkUrl})`)));
  lines.push(frameLineRaw(color.greenDim('  card badge →  ') + color.green(result.badgeCardUrl)));

  lines.push(frameEmpty());

  // Save card
  lines.push(frameLineRaw(color.greenBold('SAVE CARD')));
  lines.push(frameLineRaw(color.green('Download your holographic card as a PNG.')));
  lines.push(frameEmpty());
  lines.push(frameLineRaw(color.greenDim('  download →  ') + color.green(result.cardImageUrl)));

  lines.push(frameEmpty());

  // Email — still important, just quieter
  lines.push(frameLineRaw(color.amber('Verify your email to validate this pre-registration.')));
  lines.push(frameLineRaw(color.amber(`Check: ${result.email}`)));

  lines.push(frameEmpty());
  lines.push(frameScanline());
  lines.push(frameBottom());
  lines.push('');

  writeLines(lines);
}

/** Render an error screen */
export function renderError(message: string): void {
  const lines: string[] = [];

  lines.push('');
  lines.push(frameTop());
  lines.push(frameScanline());
  lines.push(frameEmpty());

  lines.push(frameLineRaw(color.red('✗ ERROR')));
  lines.push(frameLineRaw(color.red(message)));

  lines.push(frameEmpty());
  lines.push(frameScanline());
  lines.push(frameBottom());
  lines.push('');

  writeLines(lines);
}

/** Render rate limit screen */
export function renderRateLimit(info: {
  fingerprint: string;
  used: number;
  max: number;
  retryIn: string;
}): void {
  const lines: string[] = [];

  lines.push('');
  lines.push(frameTop());
  lines.push(frameScanline());
  lines.push(frameEmpty());

  lines.push(frameLineRaw(color.red('✗ RATE LIMIT')));
  lines.push(frameLineRaw(color.red('This machine has reached the pre-registration limit.')));
  lines.push(frameLineRaw(color.red(`Try again in ${info.retryIn}.`)));
  lines.push(frameEmpty());
  lines.push(frameLineRaw(color.greenDim(
    `Machine ID: ${info.fingerprint.slice(0, 12)}... (${info.used}/${info.max} used in 24h)`
  )));

  lines.push(frameEmpty());
  lines.push(frameScanline());
  lines.push(frameBottom());
  lines.push('');

  writeLines(lines);
}

/** Render a content page (about, terms, charter) inside CRT frame */
export function renderContentPage(title: string, content: string): void {
  const lines: string[] = [];

  lines.push('');
  lines.push(frameTop());
  lines.push(frameScanline());
  lines.push(frameEmpty());

  lines.push(frameLineRaw(color.greenBold(title)));
  lines.push(frameLineRaw(color.greenDim('─'.repeat(title.length))));
  lines.push(frameEmpty());

  // Word-wrap content to fit frame
  const maxW = INNER_W - 2;
  for (const paragraph of content.split('\n\n')) {
    const words = paragraph.replace(/\n/g, ' ').split(/\s+/);
    let line = '';
    for (const word of words) {
      if (line.length + word.length + 1 > maxW) {
        lines.push(frameLineRaw(color.green(line)));
        line = word;
      } else {
        line = line ? line + ' ' + word : word;
      }
    }
    if (line) lines.push(frameLineRaw(color.green(line)));
    lines.push(frameEmpty());
  }

  lines.push(frameLineRaw(color.greenDim('[ENTER] Back')));

  lines.push(frameEmpty());
  lines.push(frameScanline());
  lines.push(frameBottom());
  lines.push('');

  writeLines(lines);
}

/** Inline validation error (single line, no frame) */
export function validationError(msg: string): void {
  process.stderr.write(`  ${color.red('✗')} ${color.red(msg)}\n`);
}

/** Inline success tick (single line, no frame) */
export function validationOk(msg: string): void {
  process.stderr.write(`  ${color.green('✓')} ${color.green(msg)}\n`);
}

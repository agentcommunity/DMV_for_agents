/**
 * ASCII text card generator for the DMV CLI.
 * Produces a mini version of the holographic card in Unicode box drawing,
 * suitable for pasting in READMEs, memory files, or sharing in chat.
 */

import { fnv1a } from './certificate.js';
import { color } from './ui.js';

// ─── Rarity system (mirrors card-draw.js) ───────────────────

function mixHash(h: number, salt: number): number {
  let m = h ^ salt;
  m = Math.imul(m ^ (m >>> 16), 0x45d9f3b);
  m = Math.imul(m ^ (m >>> 13), 0x45d9f3b);
  return (m ^ (m >>> 16)) >>> 0;
}

type Rarity = 'STANDARD' | 'ENHANCED' | 'RARE' | 'LEGENDARY';

const RARITY_SYMBOLS: Record<Rarity, string> = {
  STANDARD:  '',
  ENHANCED:  '◇',
  RARE:      '★',
  LEGENDARY: '✦',
};

function computeRarity(name: string): Rarity {
  const h = fnv1a(name);
  const roll = mixHash(h, 0x27d4eb2f) % 100;
  if (roll < 50) return 'STANDARD';
  if (roll < 80) return 'ENHANCED';
  if (roll < 95) return 'RARE';
  return 'LEGENDARY';
}

// ─── Card layout constants ───────────────────────────────────

// Inner content width (characters between │ borders, not counting them)
const CARD_INNER = 41;

function cardLine(content: string): string {
  const pad = CARD_INNER - content.length;
  return '│ ' + content + ' '.repeat(Math.max(0, pad)) + ' │';
}

function cardTop(): string {
  return '┌' + '─'.repeat(CARD_INNER + 2) + '┐';
}

function cardBottom(): string {
  return '└' + '─'.repeat(CARD_INNER + 2) + '┘';
}

function cardDivider(): string {
  return '│ ' + '─'.repeat(CARD_INNER) + ' │';
}

function cardEmpty(): string {
  return '│ ' + ' '.repeat(CARD_INNER) + ' │';
}

// ─── Public interface ────────────────────────────────────────

export interface TextCardData {
  /** Agent name without .agent suffix */
  agentName: string;
  /** Full domain e.g. my-agent.agent */
  domain: string;
  /** Certificate ID e.g. MESA-DD6-660J */
  certificateId: string;
  /** Account type for TYPE field */
  accountType?: string;
  /** Full permalink URL (without protocol) */
  viewUrl: string;
}

/**
 * Generate a plain-text card (no ANSI color codes).
 * Used internally by both generateTextCard() and generateMarkdownCard().
 */
function buildPlainCard(data: TextCardData): string[] {
  const rarity = computeRarity(data.agentName);
  const sym = RARITY_SYMBOLS[rarity];
  const rarityLabel = sym ? `${sym} ${rarity}` : 'STANDARD';
  const type = data.accountType ?? 'Agent';

  // Truncate the URL to fit the inner width (allow "→ " prefix = 2 chars)
  const maxUrlLen = CARD_INNER - 2;
  const urlDisplay = data.viewUrl.length > maxUrlLen
    ? data.viewUrl.slice(0, maxUrlLen - 1) + '…'
    : data.viewUrl;

  const lines: string[] = [
    cardTop(),
    cardLine(`${rarityLabel.padEnd(Math.max(0, CARD_INNER - 3))}DMV`),
    cardEmpty(),
    cardLine(data.domain),
    cardEmpty(),
    cardLine(`CERT  ${data.certificateId}`),
    cardLine(`TYPE  ${type}`),
    cardEmpty(),
    cardDivider(),
    cardLine('DEPT. OF MACHINE VERIFICATION'),
    cardLine(`→ ${urlDisplay}`),
    cardBottom(),
  ];

  return lines;
}

/**
 * Generate a color-coded ASCII text card using ANSI green color.
 * Suitable for direct terminal output after registration.
 */
export function generateTextCard(data: TextCardData): string {
  const plain = buildPlainCard(data);
  // Color the border characters dim-green, content bright green
  const colored = plain.map((line) => {
    // Lines that are purely structural (top/bottom/divider)
    if (line.startsWith('┌') || line.startsWith('└')) {
      return color.greenDim(line);
    }
    if (line === cardDivider()) {
      return color.greenDim(line);
    }
    if (line === cardEmpty()) {
      return color.greenDim(line);
    }
    // Content lines: dim the border chars, green the content
    const inner = line.slice(2, -2); // strip "│ " prefix and " │" suffix
    return color.greenDim('│ ') + color.green(inner) + color.greenDim(' │');
  });
  return colored.join('\n');
}

/**
 * Generate a markdown-ready code block of the text card.
 * No ANSI color codes — safe to paste in READMEs and memory files.
 */
export function generateMarkdownCard(data: TextCardData): string {
  const plain = buildPlainCard(data);
  return '```\n' + plain.join('\n') + '\n```';
}

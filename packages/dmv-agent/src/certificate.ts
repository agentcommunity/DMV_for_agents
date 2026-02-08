// Certificate ID generation — content-addressed via FNV-1a hash
// Extracted from CRTTerminal.js for reuse in CLI/MCP

const ID_WORDS = [
  'NOVA', 'APEX', 'FLUX', 'NEON', 'VOID', 'BYTE', 'CORE', 'DART',
  'ECHO', 'GRID', 'HALO', 'IRON', 'JADE', 'KILO', 'LYNX', 'MESA',
  'NODE', 'ONYX', 'PEAK', 'QUAD', 'REEF', 'SYNC', 'TRON', 'UNIT',
  'VOLT', 'WARP', 'XRAY', 'ZERO', 'ZETA', 'OMNI', 'AURA', 'BOLT',
];

const CHARSET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** FNV-1a 32-bit hash */
export function fnv1a(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Luhn mod-36 check character */
function luhnCheck(body: string): string {
  let sum = 0;
  for (let i = body.length - 1, alt = true; i >= 0; i--, alt = !alt) {
    let val = CHARSET.indexOf(body[i]);
    if (alt) {
      val *= 2;
      if (val >= 36) val -= 35;
    }
    sum += val;
  }
  return CHARSET[(36 - (sum % 36)) % 36];
}

/**
 * Generate a content-addressed certificate ID.
 * Format: WORD-XXX-XXXC (e.g. NOVA-7F3-AB2C)
 *
 * @param fields - array of field values (order matters)
 * @param accountType - 'org' | 'individual' | 'agent'
 */
export function generateCertificateId(
  fields: string[],
  accountType: string,
): string {
  const content = fields.join('|') + '|' + accountType;
  const hash = fnv1a(content);
  const word = ID_WORDS[hash & 0x1f];
  const hex = ((hash >>> 5) & 0xffffff)
    .toString(16)
    .toUpperCase()
    .padStart(6, '0');
  const body = word + hex;
  const check = luhnCheck(body);
  return `${word}-${hex.slice(0, 3)}-${hex.slice(3)}${check}`;
}

/** Verify a certificate ID's check digit */
export function verifyCertificateId(id: string): boolean {
  const clean = id.replace(/-/g, '');
  if (clean.length < 5) return false;
  const body = clean.slice(0, -1);
  const check = clean.slice(-1);
  return luhnCheck(body) === check;
}

const CHARSET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

export function normalizeCertificateId(value: string): string {
  return value.trim().toUpperCase();
}

export function verifyCertificateId(value: string): boolean {
  const normalized = normalizeCertificateId(value);
  if (!/^[A-Z]{4}-[0-9A-F]{3}-[0-9A-F]{3}[0-9A-Z]$/.test(normalized)) return false;
  const clean = normalized.replace(/-/g, '');

  const body = clean.slice(0, -1);
  const check = clean.slice(-1);
  let sum = 0;
  for (let index = body.length - 1, alternate = true; index >= 0; index -= 1, alternate = !alternate) {
    let valueAtIndex = CHARSET.indexOf(body[index]);
    if (alternate) {
      valueAtIndex *= 2;
      if (valueAtIndex >= 36) valueAtIndex -= 35;
    }
    sum += valueAtIndex;
  }
  return CHARSET[(36 - (sum % 36)) % 36] === check;
}

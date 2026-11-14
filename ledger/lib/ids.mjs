import crypto from 'node:crypto';

// 0, O, 1, I and L are left out because they're easy to misread.
export const ID_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const ID_CHAR = '[2-9A-HJKMNP-Z]';

export function randomInvoiceId() {
  let id = '';
  for (let i = 0; i < 4; i++) id += ID_ALPHABET[crypto.randomInt(ID_ALPHABET.length)];
  return id;
}

export function lineRef(invoiceId, suffix) {
  return `${invoiceId}-${String(suffix).padStart(2, '0')}`;
}

// Find every invoice-number-shaped token in free text such as
// "inv k7m2-01" or "Payment for K7M2". Callers check which ones exist.
export function findRefs(text) {
  const upper = String(text || '').toUpperCase();
  const re = new RegExp(`(?<![A-Z0-9])(${ID_CHAR}{4})(?:\\s*-\\s*(\\d{2}))?(?![A-Z0-9])`, 'g');
  const out = [];
  for (const m of upper.matchAll(re)) out.push({ id: m[1], suffix: m[2] ? Number(m[2]) : null });
  return out;
}

import crypto from 'node:crypto';

const TOKEN_TTL_MS = 15 * 60 * 1000;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_LINKS_PER_HOUR = 5;
export const COOKIE = 'pk_admin';

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const token = () => crypto.randomBytes(32).toString('base64url');

// Returns the raw token to email, or null if the email isn't the admin's or
// too many links were sent recently. Callers show the same message either way.
export function issueLoginToken(db, email, adminEmail, now = Date.now()) {
  if (String(email || '').trim().toLowerCase() !== adminEmail.toLowerCase()) return null;
  db.prepare('DELETE FROM login_tokens WHERE expires_at < ?').run(now - 24 * 3600 * 1000);
  const recent = db.prepare('SELECT COUNT(*) AS n FROM login_tokens WHERE created_at > ?').get(now - 3600 * 1000).n;
  if (recent >= MAX_LINKS_PER_HOUR) return null;
  const raw = token();
  db.prepare('INSERT INTO login_tokens (hash, expires_at, created_at) VALUES (?, ?, ?)').run(sha(raw), now + TOKEN_TTL_MS, now);
  return raw;
}

// Single use. Returns a raw session token, or null.
export function redeemLoginToken(db, raw, now = Date.now()) {
  if (!raw) return null;
  const row = db.prepare('SELECT * FROM login_tokens WHERE hash = ?').get(sha(raw));
  if (!row || row.used_at || row.expires_at < now) return null;
  const upd = db.prepare('UPDATE login_tokens SET used_at = ? WHERE hash = ? AND used_at IS NULL').run(now, row.hash);
  if (upd.changes !== 1) return null;
  return createSession(db, now);
}

export function createSession(db, now = Date.now()) {
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now);
  const session = token();
  db.prepare('INSERT INTO sessions (hash, expires_at, created_at) VALUES (?, ?, ?)').run(sha(session), now + SESSION_TTL_MS, now);
  return session;
}

export function loginTokenValid(db, raw, now = Date.now()) {
  if (!raw) return false;
  const row = db.prepare('SELECT * FROM login_tokens WHERE hash = ?').get(sha(raw));
  return !!row && !row.used_at && row.expires_at >= now;
}

export function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function sessionValid(db, req, now = Date.now()) {
  const raw = parseCookies(req.headers.cookie)[COOKIE];
  if (!raw) return false;
  const row = db.prepare('SELECT expires_at FROM sessions WHERE hash = ?').get(sha(raw));
  return !!row && row.expires_at > now;
}

export function endSession(db, req) {
  const raw = parseCookies(req.headers.cookie)[COOKIE];
  if (raw) db.prepare('DELETE FROM sessions WHERE hash = ?').run(sha(raw));
}

export function sessionCookie(raw, secure) {
  const attrs = [`${COOKIE}=${raw}`, 'Path=/admin', 'HttpOnly', 'SameSite=Lax', `Max-Age=${SESSION_TTL_MS / 1000}`];
  if (secure) attrs.push('Secure');
  return attrs.join('; ');
}

export function clearCookie(secure) {
  return `${COOKIE}=; Path=/admin; HttpOnly; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`;
}

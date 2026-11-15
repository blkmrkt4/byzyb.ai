// Sign-in by emailed magic link, for the people on the access list only.
import crypto from 'node:crypto';
import { LedgerError, audit } from './ledger.mjs';
import { tx } from './db.mjs';

const TOKEN_TTL_MS = 15 * 60 * 1000;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const LINKS_PER_PERSON_PER_HOUR = 5;
const LINKS_PER_HOUR = 30;
export const COOKIE = 'pk_admin';

// admin: everything, including who has access. viewer: can look, can't change.
export const ROLES = ['admin', 'viewer'];

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const token = () => crypto.randomBytes(32).toString('base64url');
const nowIso = () => new Date().toISOString();
export const normEmail = (s) => String(s || '').trim().toLowerCase();
const validEmail = (s) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s);

// ---------- the access list ----------

// The first time the ledger starts with an empty list, these people become admins.
export function seedUsers(db, emails) {
  if (db.prepare('SELECT COUNT(*) AS n FROM users').get().n) return 0;
  const now = nowIso();
  const ins = db.prepare("INSERT OR IGNORE INTO users (email, role, added_by, created_at, updated_at) VALUES (?, 'admin', 'setup', ?, ?)");
  let n = 0;
  for (const e of emails.map(normEmail).filter(validEmail)) n += ins.run(e, now, now).changes;
  return n;
}

export function getUser(db, email) {
  return db.prepare('SELECT email, name, role FROM users WHERE email = ? AND removed_at IS NULL').get(normEmail(email)) || null;
}

export function listUsers(db) {
  return db.prepare(`
    SELECT u.email, u.name, u.role, u.added_by, u.created_at,
           (SELECT MAX(created_at) FROM sessions s WHERE s.email = u.email) AS last_sign_in
      FROM users u WHERE u.removed_at IS NULL ORDER BY u.role, u.email`).all()
    .map((u) => ({ ...u, last_sign_in: u.last_sign_in ? new Date(u.last_sign_in).toISOString() : null }));
}

const adminCount = (db) => db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND removed_at IS NULL").get().n;

function checkRole(role) {
  if (!ROLES.includes(role)) throw new LedgerError('Access must be “admin” or “viewer”');
}

export function addUser(db, { email, name = '', role = 'viewer' }, by) {
  const e = normEmail(email);
  if (!validEmail(e)) throw new LedgerError('Enter a valid email address');
  checkRole(role);
  return tx(db, () => {
    const row = db.prepare('SELECT * FROM users WHERE email = ?').get(e);
    if (row && !row.removed_at) throw new LedgerError(`${e} already has access`);
    const now = nowIso();
    if (row) {
      db.prepare('UPDATE users SET name = ?, role = ?, added_by = ?, removed_at = NULL, updated_at = ? WHERE email = ?')
        .run(String(name).trim(), role, by, now, e);
    } else {
      db.prepare('INSERT INTO users (email, name, role, added_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(e, String(name).trim(), role, by, now, now);
    }
    audit(db, 'user', e, 'user_add', { role });
    return getUser(db, e);
  });
}

export function updateUser(db, email, { name, role }, by) {
  const e = normEmail(email);
  return tx(db, () => {
    const u = getUser(db, e);
    if (!u) throw new LedgerError('That person isn’t on the list', 404);
    if (role !== undefined && role !== u.role) {
      checkRole(role);
      if (e === normEmail(by)) throw new LedgerError('You can’t change your own access. Ask another admin.');
      if (u.role === 'admin' && adminCount(db) <= 1) throw new LedgerError('There must always be at least one admin');
      db.prepare('UPDATE users SET role = ?, updated_at = ? WHERE email = ?').run(role, nowIso(), e);
      audit(db, 'user', e, 'user_role', { from: u.role, to: role });
    }
    if (name !== undefined && String(name).trim() !== u.name) {
      db.prepare('UPDATE users SET name = ?, updated_at = ? WHERE email = ?').run(String(name).trim(), nowIso(), e);
    }
    return getUser(db, e);
  });
}

// Takes effect at once: their sessions end and unused sign-in links stop working.
export function removeUser(db, email, by) {
  const e = normEmail(email);
  tx(db, () => {
    const u = getUser(db, e);
    if (!u) throw new LedgerError('That person isn’t on the list', 404);
    if (e === normEmail(by)) throw new LedgerError('You can’t remove yourself. Ask another admin.');
    if (u.role === 'admin' && adminCount(db) <= 1) throw new LedgerError('There must always be at least one admin');
    db.prepare('UPDATE users SET removed_at = ?, updated_at = ? WHERE email = ?').run(nowIso(), nowIso(), e);
    db.prepare('DELETE FROM sessions WHERE email = ?').run(e);
    db.prepare('DELETE FROM login_tokens WHERE email = ? AND used_at IS NULL').run(e);
    audit(db, 'user', e, 'user_remove', { role: u.role });
  });
}

// ---------- sign-in links ----------

// Returns { raw, email } to send, or null if the address isn't on the list or
// too many links were asked for. Callers show the same message either way, so
// the sign-in page doesn't reveal who has access.
export function issueLoginToken(db, email, now = Date.now()) {
  const user = getUser(db, email);
  if (!user) return null;
  db.prepare('DELETE FROM login_tokens WHERE expires_at < ?').run(now - 24 * 3600 * 1000);
  const hourAgo = now - 3600 * 1000;
  const mine = db.prepare('SELECT COUNT(*) AS n FROM login_tokens WHERE created_at > ? AND email = ?').get(hourAgo, user.email).n;
  const all = db.prepare('SELECT COUNT(*) AS n FROM login_tokens WHERE created_at > ?').get(hourAgo).n;
  if (mine >= LINKS_PER_PERSON_PER_HOUR || all >= LINKS_PER_HOUR) return null;
  const raw = token();
  db.prepare('INSERT INTO login_tokens (hash, email, expires_at, created_at) VALUES (?, ?, ?, ?)').run(sha(raw), user.email, now + TOKEN_TTL_MS, now);
  return { raw, email: user.email };
}

// Single use. Returns a raw session token, or null.
export function redeemLoginToken(db, raw, now = Date.now()) {
  if (!raw) return null;
  const row = db.prepare('SELECT * FROM login_tokens WHERE hash = ?').get(sha(raw));
  if (!row || row.used_at || row.expires_at < now || !getUser(db, row.email)) return null;
  const upd = db.prepare('UPDATE login_tokens SET used_at = ? WHERE hash = ? AND used_at IS NULL').run(now, row.hash);
  if (upd.changes !== 1) return null;
  return createSession(db, row.email, now);
}

export function createSession(db, email, now = Date.now()) {
  const e = normEmail(email);
  if (!getUser(db, e)) throw new Error(`createSession: ${e} is not on the access list`);
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now);
  const session = token();
  db.prepare('INSERT INTO sessions (hash, email, expires_at, created_at) VALUES (?, ?, ?, ?)').run(sha(session), e, now + SESSION_TTL_MS, now);
  return session;
}

export function loginTokenValid(db, raw, now = Date.now()) {
  if (!raw) return false;
  const row = db.prepare('SELECT * FROM login_tokens WHERE hash = ?').get(sha(raw));
  return !!row && !row.used_at && row.expires_at >= now && !!getUser(db, row.email);
}

export function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

// The signed-in person, or null. Role is read fresh each time, so a change
// or removal applies to their very next click.
export function sessionUser(db, req, now = Date.now()) {
  const raw = parseCookies(req.headers.cookie)[COOKIE];
  if (!raw) return null;
  return db.prepare(`
    SELECT u.email, u.name, u.role FROM sessions s JOIN users u ON u.email = s.email
     WHERE s.hash = ? AND s.expires_at > ? AND u.removed_at IS NULL`).get(sha(raw), now) || null;
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

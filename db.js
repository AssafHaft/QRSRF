import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';

const DATA_DIR = process.env.DATA_DIR || path.join(import.meta.dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'qrsrf.sqlite'));
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS batches (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    label      TEXT NOT NULL,
    benefit    TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    expires_at TEXT
  );

  CREATE TABLE IF NOT EXISTS codes (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    batch_id          INTEGER NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
    token             TEXT NOT NULL UNIQUE,
    recipient_name    TEXT NOT NULL DEFAULT '',
    recipient_contact TEXT NOT NULL DEFAULT '',
    status            TEXT NOT NULL DEFAULT 'active',
    created_at        TEXT NOT NULL,
    expires_at        TEXT,
    sent_at           TEXT,
    redeemed_at       TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_codes_batch ON codes(batch_id);
`);

export const now = () => new Date().toISOString();

export function createBatch({ label, benefit = '', expiresAt = null, count, recipients = [] }) {
  const ts = now();
  const { lastInsertRowid: batchId } = db
    .prepare('INSERT INTO batches (label, benefit, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .run(label, benefit, ts, expiresAt);

  const insert = db.prepare(
    `INSERT INTO codes (batch_id, token, recipient_name, recipient_contact, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  );
  const total = Math.max(count, recipients.length);
  for (let i = 0; i < total; i++) {
    const token = crypto.randomBytes(12).toString('base64url');
    const r = recipients[i] || {};
    insert.run(batchId, token, r.name || '', r.contact || '', ts, expiresAt);
  }
  return getBatch(batchId);
}

export function listBatches() {
  return db.prepare(`
    SELECT b.*,
      COUNT(c.id) AS total,
      SUM(CASE WHEN c.status = 'used' THEN 1 ELSE 0 END) AS used,
      SUM(CASE WHEN c.status = 'void' THEN 1 ELSE 0 END) AS voided,
      SUM(CASE WHEN c.status = 'active' AND c.expires_at IS NOT NULL AND c.expires_at <= ? THEN 1 ELSE 0 END) AS expired
    FROM batches b LEFT JOIN codes c ON c.batch_id = b.id
    GROUP BY b.id ORDER BY b.id DESC
  `).all(now());
}

export function getBatch(id) {
  return db.prepare('SELECT * FROM batches WHERE id = ?').get(id);
}

export function listCodes(batchId) {
  return db.prepare('SELECT * FROM codes WHERE batch_id = ? ORDER BY id').all(batchId);
}

export function getCode(id) {
  return db.prepare('SELECT * FROM codes WHERE id = ?').get(id);
}

export function getCodeByToken(token) {
  return db.prepare(`
    SELECT c.*, b.label AS batch_label, b.benefit
    FROM codes c JOIN batches b ON b.id = c.batch_id
    WHERE c.token = ?
  `).get(token);
}

export function updateRecipient(id, { name, contact }) {
  db.prepare('UPDATE codes SET recipient_name = ?, recipient_contact = ? WHERE id = ?')
    .run(name || '', contact || '', id);
  return getCode(id);
}

export function markSent(id, sent) {
  db.prepare('UPDATE codes SET sent_at = ? WHERE id = ?').run(sent ? now() : null, id);
  return getCode(id);
}

export function voidCode(id) {
  db.prepare("UPDATE codes SET status = 'void' WHERE id = ? AND status = 'active'").run(id);
  return getCode(id);
}

// Atomically consume a code: succeeds only if it is still active and not expired.
export function redeemCode(token) {
  const ts = now();
  const { changes } = db.prepare(`
    UPDATE codes SET status = 'used', redeemed_at = ?
    WHERE token = ? AND status = 'active' AND (expires_at IS NULL OR expires_at > ?)
  `).run(ts, token, ts);
  return changes === 1;
}

// Effective state, folding expiry into the stored status.
export function codeState(code) {
  if (!code) return 'invalid';
  if (code.status === 'active' && code.expires_at && code.expires_at <= now()) return 'expired';
  return code.status; // active | used | void
}

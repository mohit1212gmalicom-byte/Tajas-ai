import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { getSessionSecret } from './config.ts';

const DATA_DIR = path.resolve(process.cwd(), 'data');
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const DB_PATH = path.join(DATA_DIR, 'tejas.db');
export const db = new DatabaseSync(DB_PATH);

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    password_hash TEXT,
    role TEXT NOT NULL DEFAULT 'user',
    is_guest INTEGER NOT NULL DEFAULT 0,
    phone_number TEXT,
    phone_verified INTEGER NOT NULL DEFAULT 0,
    phone_verified_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    token_hash TEXT UNIQUE NOT NULL,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS subscriptions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    plan_id TEXT NOT NULL,
    status TEXT NOT NULL,
    billing_period TEXT NOT NULL,
    amount_inr INTEGER NOT NULL DEFAULT 0,
    is_test_mode INTEGER NOT NULL DEFAULT 1,
    auto_renew INTEGER NOT NULL DEFAULT 0,
    started_at TEXT NOT NULL,
    expires_at TEXT,
    cancelled_at TEXT,
    last_payment_id TEXT,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_subscriptions_user ON subscriptions(user_id, updated_at DESC);

  CREATE TABLE IF NOT EXISTS usage_daily (
    user_id TEXT NOT NULL,
    ist_date TEXT NOT NULL,
    chat_count INTEGER NOT NULL DEFAULT 0,
    premium_chat_count INTEGER NOT NULL DEFAULT 0,
    image_understand_count INTEGER NOT NULL DEFAULT 0,
    image_gen_count INTEGER NOT NULL DEFAULT 0,
    video_gen_count INTEGER NOT NULL DEFAULT 0,
    voice_gen_count INTEGER NOT NULL DEFAULT 0,
    voice_transcribe_count INTEGER NOT NULL DEFAULT 0,
    estimated_cost_inr REAL NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (user_id, ist_date),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS payments (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    order_id TEXT UNIQUE NOT NULL,
    gateway_payment_id TEXT,
    plan_id TEXT NOT NULL,
    billing_period TEXT NOT NULL,
    amount_inr INTEGER NOT NULL,
    currency TEXT NOT NULL DEFAULT 'INR',
    mode TEXT NOT NULL,
    status TEXT NOT NULL,
    signature_verified INTEGER NOT NULL DEFAULT 0,
    webhook_event_id TEXT,
    created_at TEXT NOT NULL,
    verified_at TEXT,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS webhook_events (
    event_id TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    event_type TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    received_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS system_settings (
    key TEXT PRIMARY KEY,
    value_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    title TEXT NOT NULL,
    model TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_conversations_user ON conversations(user_id, updated_at DESC);

  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    role TEXT NOT NULL,
    mode TEXT NOT NULL DEFAULT 'chat',
    model TEXT,
    content TEXT NOT NULL,
    media_url TEXT,
    media_mime TEXT,
    cost_inr REAL NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, created_at ASC);

  CREATE TABLE IF NOT EXISTS audit_logs (
    id TEXT PRIMARY KEY,
    actor_user_id TEXT,
    target_user_id TEXT,
    action TEXT NOT NULL,
    details_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS system_errors (
    id TEXT PRIMARY KEY,
    route TEXT NOT NULL,
    feature TEXT,
    user_id TEXT,
    status_code INTEGER NOT NULL,
    error_code TEXT,
    message TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_system_errors_created ON system_errors(created_at DESC);
`);

// Safe forward migrations for existing databases
function ensureColumn(table: string, column: string, definition: string) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

ensureColumn('users', 'phone_number', 'TEXT');
ensureColumn('users', 'phone_verified', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('users', 'phone_verified_at', 'TEXT');
ensureColumn('usage_daily', 'voice_transcribe_count', 'INTEGER NOT NULL DEFAULT 0');

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${derived}`;
}

export function verifyPassword(password: string, storedHash: string | null | undefined): boolean {
  if (!storedHash || !storedHash.includes(':')) return false;
  const [salt, expectedHex] = storedHash.split(':');
  if (!salt || !expectedHex) return false;
  const derived = crypto.scryptSync(password, salt, 64);
  const expected = Buffer.from(expectedHex, 'hex');
  if (derived.length !== expected.length) return false;
  return crypto.timingSafeEqual(derived, expected);
}

export function hashToken(rawToken: string): string {
  return crypto.createHmac('sha256', getSessionSecret()).update(rawToken).digest('hex');
}

export function signTestPayload(payload: string): string {
  return crypto.createHmac('sha256', getSessionSecret()).update(payload).digest('hex');
}

export function verifyHmacSignature(payload: string, signatureHex: string, secret: string): boolean {
  if (!signatureHex || !secret) return false;
  const expectedHex = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  const a = Buffer.from(expectedHex, 'utf8');
  const b = Buffer.from(signatureHex.trim(), 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export function writeAuditLog(
  actorUserId: string | null,
  targetUserId: string | null,
  action: string,
  details: Record<string, unknown>
): void {
  db.prepare(
    `INSERT INTO audit_logs (id, actor_user_id, target_user_id, action, details_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    crypto.randomUUID(),
    actorUserId,
    targetUserId,
    action,
    JSON.stringify(details),
    new Date().toISOString()
  );
}

export function logSystemError(params: {
  route: string;
  feature?: string | null;
  userId?: string | null;
  statusCode: number;
  errorCode?: string | null;
  message: string;
}): void {
  try {
    db.prepare(
      `INSERT INTO system_errors (id, route, feature, user_id, status_code, error_code, message, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      crypto.randomUUID(),
      params.route,
      params.feature ?? null,
      params.userId ?? null,
      params.statusCode,
      params.errorCode ?? null,
      params.message.slice(0, 1000),
      new Date().toISOString()
    );
  } catch {
    // Never throw from error logging
  }
}

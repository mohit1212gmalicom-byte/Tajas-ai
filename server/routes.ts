import crypto from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { Router } from 'express';
import {
  BRAND_INFO,
  FeatureKind,
  getIstDateKey,
  getPhoneOtpProviderStatus,
  PLANS,
} from './config.ts';
import {
  db,
  hashPassword,
  hashToken,
  logSystemError,
  verifyPassword,
  writeAuditLog,
} from './db.ts';
import {
  normalizeGeminiError,
  runAudioTranscription,
  runChatGeneration,
  runImageTextFixer,
  runVoiceOverGeneration,
  streamChatGeneration,
} from './gemini.ts';
import {
  checkFeatureAccess,
  getEffectiveMembershipState,
  getGlobalUsageTotals,
  getSystemSettings,
  recordUsageIncrement,
  SystemSettings,
  updateSystemSettings,
} from './membership.ts';
import { createProjectZipArchive } from './zipExport.ts';

export interface UserRow {
  id: string;
  email: string;
  name: string;
  password_hash: string | null;
  role: 'user' | 'admin';
  is_guest: number;
  phone_number: string | null;
  phone_verified: number;
  phone_verified_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface AuthedRequest extends Request {
  user?: UserRow;
  sessionToken?: string;
}

const SESSION_COOKIE_NAME = 'tejas_session';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function parseCookies(cookieHeader: string | undefined): Record<string, string> {
  if (!cookieHeader) return {};
  const result: Record<string, string> = {};
  for (const part of cookieHeader.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    if (key) result[key] = decodeURIComponent(val);
  }
  return result;
}

function setSessionCookie(req: Request, res: Response, rawToken: string): void {
  const isHttps = req.secure || req.get('x-forwarded-proto') === 'https';
  if (isHttps) {
    res.setHeader(
      'Set-Cookie',
      `${SESSION_COOKIE_NAME}=${encodeURIComponent(rawToken)}; Path=/; HttpOnly; Secure; SameSite=None; Partitioned; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`
    );
  } else {
    res.setHeader(
      'Set-Cookie',
      `${SESSION_COOKIE_NAME}=${encodeURIComponent(rawToken)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`
    );
  }
}

function clearSessionCookie(req: Request, res: Response): void {
  const isHttps = req.secure || req.get('x-forwarded-proto') === 'https';
  if (isHttps) {
    res.setHeader(
      'Set-Cookie',
      `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=None; Partitioned; Max-Age=0`
    );
  } else {
    res.setHeader(
      'Set-Cookie',
      `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`
    );
  }
}

function createSessionForUser(userId: string): string {
  const rawToken = crypto.randomBytes(32).toString('hex');
  const tokenHash = hashToken(rawToken);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS).toISOString();

  db.prepare(
    `INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run(crypto.randomUUID(), userId, tokenHash, expiresAt, now.toISOString());

  return rawToken;
}

function resolveUserFromRequest(req: AuthedRequest): UserRow | null {
  const authHeader = req.get('authorization');
  let rawToken: string | undefined;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    rawToken = authHeader.slice(7).trim();
  }
  if (!rawToken) {
    const cookies = parseCookies(req.headers.cookie);
    rawToken = cookies[SESSION_COOKIE_NAME];
  }
  if (!rawToken) return null;

  const tokenHash = hashToken(rawToken);
  const nowIso = new Date().toISOString();
  const session = db
    .prepare(`SELECT user_id, expires_at FROM sessions WHERE token_hash = ?`)
    .get(tokenHash) as { user_id: string; expires_at: string } | undefined;

  if (!session || session.expires_at <= nowIso) {
    return null;
  }

  const user = db.prepare(`SELECT * FROM users WHERE id = ?`).get(session.user_id) as UserRow | undefined;
  if (!user) return null;
  req.sessionToken = rawToken;
  return user;
}

function csrfCheck(req: Request, res: Response, next: NextFunction): void {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    next();
    return;
  }
  const authHeader = req.get('authorization');
  if (authHeader && authHeader.startsWith('Bearer ')) {
    next();
    return;
  }
  const customHeader = req.get('x-requested-with');
  const origin = req.get('origin');
  const expectedHost = (req.get('x-forwarded-host') || req.get('host') || '').split(',')[0].trim();

  if (customHeader === 'TEJAS-AI') {
    next();
    return;
  }
  if (origin && expectedHost) {
    try {
      const originHost = new URL(origin).host;
      if (originHost === expectedHost) {
        next();
        return;
      }
    } catch {
      // fall through
    }
  }
  res.status(403).json({ error: 'CSRF validation failed. Missing X-Requested-With or valid Origin.' });
}

function requireAuth(req: AuthedRequest, res: Response, next: NextFunction): void {
  const user = resolveUserFromRequest(req);
  if (!user) {
    res.status(401).json({ error: 'Authentication required.' });
    return;
  }
  req.user = user;
  next();
}

function requireAdmin(req: AuthedRequest, res: Response, next: NextFunction): void {
  const user = resolveUserFromRequest(req);
  if (!user) {
    res.status(401).json({ error: 'Authentication required.' });
    return;
  }
  if (user.role !== 'admin') {
    res.status(403).json({ error: 'Admin privileges required (Mohit Jaat).' });
    return;
  }
  req.user = user;
  next();
}

function sanitizeUser(user: UserRow) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    isGuest: Boolean(user.is_guest),
    phoneNumber: user.phone_number || null,
    phoneVerified: Boolean(user.phone_verified),
    phoneVerifiedAt: user.phone_verified_at || null,
    createdAt: user.created_at,
  };
}

function getAdminAuthRecord(): { hash: string; claimedByEmail: string; claimedAt: string } | null {
  const row = db.prepare(`SELECT value_json FROM system_settings WHERE key = 'admin_auth'`).get() as
    | { value_json: string }
    | undefined;
  if (!row) return null;
  try {
    return JSON.parse(row.value_json);
  } catch {
    return null;
  }
}

export function createApiRouter(): Router {
  const router = Router();
  router.use(csrfCheck);

  // ---------------- Public Plan Catalog (Single Unlimited FREE Plan) ----------------
  router.get('/plans', (_req, res) => {
    res.json({
      brand: BRAND_INFO.brand,
      tagline: BRAND_INFO.tagline,
      developer: BRAND_INFO.developer,
      currency: 'INR',
      timezone: 'Asia/Kolkata',
      plans: [
        {
          ...PLANS.FREE,
          unlimited: true,
        },
      ],
    });
  });

  // ---------------- Authentication & Phone OTP Verification ----------------
  router.post('/auth/guest', (req: AuthedRequest, res) => {
    const existing = resolveUserFromRequest(req);
    if (existing) {
      const membership = getEffectiveMembershipState(existing.id);
      res.json({ user: sanitizeUser(existing), membership, sessionToken: req.sessionToken });
      return;
    }

    const now = new Date().toISOString();
    const userId = crypto.randomUUID();
    const shortId = userId.slice(0, 8);
    const email = `guest_${shortId}@tejas.local`;

    db.prepare(
      `INSERT INTO users (id, email, name, password_hash, role, is_guest, created_at, updated_at)
       VALUES (?, ?, ?, NULL, 'user', 1, ?, ?)`
    ).run(userId, email, `Guest ${shortId}`, now, now);

    const token = createSessionForUser(userId);
    setSessionCookie(req, res, token);

    const user = db.prepare(`SELECT * FROM users WHERE id = ?`).get(userId) as unknown as UserRow;
    const membership = getEffectiveMembershipState(userId);
    res.status(201).json({ user: sanitizeUser(user), membership, sessionToken: token });
  });

  router.post('/auth/register', (req: AuthedRequest, res) => {
    const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    const password = typeof req.body?.password === 'string' ? req.body.password : '';

    if (!email || !email.includes('@') || email.length > 160) {
      res.status(400).json({ error: 'Please provide a valid email address.' });
      return;
    }
    if (!name || name.length < 2 || name.length > 80) {
      res.status(400).json({ error: 'Name must be between 2 and 80 characters.' });
      return;
    }
    if (password.length < 6 || password.length > 128) {
      res.status(400).json({ error: 'Password must be between 6 and 128 characters.' });
      return;
    }

    const existing = db.prepare(`SELECT id FROM users WHERE email = ?`).get(email);
    if (existing) {
      res.status(409).json({ error: 'An account with this email already exists. Please sign in.' });
      return;
    }

    const now = new Date().toISOString();
    const currentUser = resolveUserFromRequest(req);
    const passwordHash = hashPassword(password);

    let userId: string;
    if (currentUser && currentUser.is_guest === 1) {
      userId = currentUser.id;
      db.prepare(
        `UPDATE users SET email = ?, name = ?, password_hash = ?, is_guest = 0, updated_at = ? WHERE id = ?`
      ).run(email, name, passwordHash, now, userId);
    } else {
      userId = crypto.randomUUID();
      db.prepare(
        `INSERT INTO users (id, email, name, password_hash, role, is_guest, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'user', 0, ?, ?)`
      ).run(userId, email, name, passwordHash, now, now);
    }

    const token = createSessionForUser(userId);
    setSessionCookie(req, res, token);

    const user = db.prepare(`SELECT * FROM users WHERE id = ?`).get(userId) as unknown as UserRow;
    const membership = getEffectiveMembershipState(userId);
    writeAuditLog(userId, userId, 'USER_REGISTERED', { email });
    res.status(201).json({ user: sanitizeUser(user), membership, sessionToken: token });
  });

  router.post('/auth/login', (req: AuthedRequest, res) => {
    const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    const password = typeof req.body?.password === 'string' ? req.body.password : '';

    if (!email || !password) {
      res.status(400).json({ error: 'Email and password are required.' });
      return;
    }

    const user = db.prepare(`SELECT * FROM users WHERE email = ?`).get(email) as UserRow | undefined;
    if (!user || user.is_guest === 1 || !verifyPassword(password, user.password_hash)) {
      res.status(401).json({ error: 'Invalid email or password.' });
      return;
    }

    const token = createSessionForUser(user.id);
    setSessionCookie(req, res, token);
    const membership = getEffectiveMembershipState(user.id);
    res.json({ user: sanitizeUser(user), membership, sessionToken: token });
  });

  router.post('/auth/logout', (req: AuthedRequest, res) => {
    const user = resolveUserFromRequest(req);
    if (req.sessionToken) {
      db.prepare(`DELETE FROM sessions WHERE token_hash = ?`).run(hashToken(req.sessionToken));
    }
    clearSessionCookie(req, res);
    res.json({ ok: true, loggedOutUserId: user?.id || null });
  });

  router.get('/auth/me', requireAuth, (req: AuthedRequest, res) => {
    const user = req.user!;
    const membership = getEffectiveMembershipState(user.id);
    res.json({ user: sanitizeUser(user), membership });
  });

  router.get('/auth/phone/status', requireAuth, (req: AuthedRequest, res) => {
    const status = getPhoneOtpProviderStatus();
    res.json({
      providerConfigured: status.configured,
      provider: status.provider,
      phoneNumber: req.user!.phone_number || null,
      phoneVerified: Boolean(req.user!.phone_verified),
      phoneVerifiedAt: req.user!.phone_verified_at || null,
      note: status.configured
        ? 'Phone OTP verification is available.'
        : 'Phone OTP provider is not configured on the server (PHONE_OTP_PROVIDER).',
    });
  });

  router.post('/auth/phone/send-otp', requireAuth, (req: AuthedRequest, res) => {
    const status = getPhoneOtpProviderStatus();
    if (!status.configured) {
      res.status(503).json({
        error: 'Phone OTP verification is unavailable because no SMS/OTP provider is configured on the server.',
        code: 'PHONE_OTP_NOT_CONFIGURED',
      });
      return;
    }
    const phoneNumber = typeof req.body?.phoneNumber === 'string' ? req.body.phoneNumber.trim() : '';
    if (!/^\+[1-9]\d{7,14}$/.test(phoneNumber)) {
      res.status(400).json({ error: 'Enter a valid E.164 phone number (e.g., +91XXXXXXXXXX).' });
      return;
    }
    res.status(501).json({
      error: `OTP dispatch adapter for provider "${status.provider}" must be connected to live SMS API credentials.`,
      code: 'PHONE_OTP_ADAPTER_REQUIRED',
    });
  });

  router.post('/auth/phone/verify-otp', requireAuth, (_req: AuthedRequest, res) => {
    const status = getPhoneOtpProviderStatus();
    if (!status.configured) {
      res.status(503).json({
        error: 'Phone OTP provider is not configured on the server.',
        code: 'PHONE_OTP_NOT_CONFIGURED',
      });
      return;
    }
    res.status(501).json({
      error: `OTP verification adapter for provider "${status.provider}" must verify against a live OTP challenge.`,
      code: 'PHONE_OTP_ADAPTER_REQUIRED',
    });
  });

  router.get('/membership', requireAuth, (req: AuthedRequest, res) => {
    res.json({ membership: getEffectiveMembershipState(req.user!.id) });
  });

  // ---------------- Conversations (List, Search, Create, Rename, Delete) ----------------
  router.get('/conversations', requireAuth, (req: AuthedRequest, res) => {
    const q = typeof req.query?.q === 'string' ? req.query.q.trim() : '';
    const rows = q
      ? db
          .prepare(
            `SELECT id, title, model, created_at, updated_at
             FROM conversations
             WHERE user_id = ? AND title LIKE ?
             ORDER BY updated_at DESC LIMIT 60`
          )
          .all(req.user!.id, `%${q}%`)
      : db
          .prepare(
            `SELECT id, title, model, created_at, updated_at
             FROM conversations
             WHERE user_id = ?
             ORDER BY updated_at DESC LIMIT 60`
          )
          .all(req.user!.id);
    res.json({ conversations: rows });
  });

  router.post('/conversations', requireAuth, (req: AuthedRequest, res) => {
    const title =
      typeof req.body?.title === 'string' && req.body.title.trim()
        ? req.body.title.trim().slice(0, 100)
        : 'New chat';
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO conversations (id, user_id, title, model, created_at, updated_at) VALUES (?, ?, ?, 'gemini-4-hydrogen', ?, ?)`
    ).run(id, req.user!.id, title, now, now);

    const conv = db.prepare(`SELECT * FROM conversations WHERE id = ?`).get(id);
    res.status(201).json({ conversation: conv });
  });

  router.patch('/conversations/:id', requireAuth, (req: AuthedRequest, res) => {
    const title = typeof req.body?.title === 'string' ? req.body.title.trim().slice(0, 100) : '';
    if (!title) {
      res.status(400).json({ error: 'Conversation title is required.' });
      return;
    }
    const now = new Date().toISOString();
    const result = db
      .prepare(`UPDATE conversations SET title = ?, updated_at = ? WHERE id = ? AND user_id = ?`)
      .run(title, now, req.params.id, req.user!.id);
    if (result.changes === 0) {
      res.status(404).json({ error: 'Conversation not found.' });
      return;
    }
    const conv = db.prepare(`SELECT * FROM conversations WHERE id = ?`).get(req.params.id);
    res.json({ conversation: conv });
  });

  router.get('/conversations/:id', requireAuth, (req: AuthedRequest, res) => {
    const conv = db
      .prepare(`SELECT * FROM conversations WHERE id = ? AND user_id = ?`)
      .get(req.params.id, req.user!.id);
    if (!conv) {
      res.status(404).json({ error: 'Conversation not found.' });
      return;
    }
    const messages = db
      .prepare(`SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC`)
      .all(req.params.id);
    res.json({ conversation: conv, messages });
  });

  router.delete('/conversations/:id', requireAuth, (req: AuthedRequest, res) => {
    const result = db
      .prepare(`DELETE FROM conversations WHERE id = ? AND user_id = ?`)
      .run(req.params.id, req.user!.id);
    if (result.changes === 0) {
      res.status(404).json({ error: 'Conversation not found.' });
      return;
    }
    res.json({ ok: true });
  });

  // ---------------- Unlimited AI Chat (SSE Streaming + Unary + Image Understanding) ----------------
  router.post('/ai/chat/stream', requireAuth, async (req: AuthedRequest, res) => {
    const userId = req.user!.id;
    const promptInput = typeof req.body?.prompt === 'string' ? req.body.prompt.trim() : '';
    const requestedModel = 'gemini-4-hydrogen';
    const conversationIdInput =
      typeof req.body?.conversationId === 'string' ? req.body.conversationId.trim() : '';
    const imageDataUrl =
      typeof req.body?.imageDataUrl === 'string' ? req.body.imageDataUrl.trim() : '';
    const regenerate = Boolean(req.body?.regenerate);

    let convId = conversationIdInput;
    let effectivePrompt = promptInput;
    let effectiveImageDataUrl = imageDataUrl;

    if (regenerate) {
      if (!convId) {
        res.status(400).json({ error: 'conversationId is required to regenerate.' });
        return;
      }
      const owned = db
        .prepare(`SELECT id FROM conversations WHERE id = ? AND user_id = ?`)
        .get(convId, userId);
      if (!owned) {
        res.status(404).json({ error: 'Conversation not found.' });
        return;
      }
      const msgs = db
        .prepare(`SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC`)
        .all(convId) as Array<{
        id: string;
        role: 'user' | 'assistant';
        content: string;
        media_url: string | null;
      }>;
      if (msgs.length === 0) {
        res.status(400).json({ error: 'No messages in conversation to regenerate.' });
        return;
      }
      const last = msgs[msgs.length - 1];
      if (last.role === 'assistant') {
        db.prepare(`DELETE FROM messages WHERE id = ?`).run(last.id);
        msgs.pop();
      }
      const lastUser = [...msgs].reverse().find((m) => m.role === 'user');
      if (!lastUser) {
        res.status(400).json({ error: 'No user prompt found to regenerate.' });
        return;
      }
      effectivePrompt = lastUser.content;
      effectiveImageDataUrl = lastUser.media_url || '';
    } else {
      if (!effectivePrompt || effectivePrompt.length > 16000) {
        res.status(400).json({ error: 'Prompt must be between 1 and 16,000 characters.' });
        return;
      }
    }

    let imageBase64: string | undefined;
    let imageMimeType: string | undefined;
    if (effectiveImageDataUrl) {
      const match = effectiveImageDataUrl.match(
        /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/
      );
      if (!match) {
        res.status(400).json({ error: 'Invalid image format. Only PNG, JPEG, or WEBP data URLs are allowed.' });
        return;
      }
      if (match[2].length > 7_000_000) {
        res.status(400).json({ error: 'Uploaded image exceeds 5 MB limit.' });
        return;
      }
      imageMimeType = match[1];
      imageBase64 = match[2];
    }

    const feature: FeatureKind = imageBase64 ? 'image_understand' : 'chat_standard';
    const gate = checkFeatureAccess(userId, feature);
    if (!gate.allowed) {
      res.status(gate.statusCode).json({
        error: gate.reason,
        code: gate.code,
        membership: getEffectiveMembershipState(userId),
      });
      return;
    }

    if (convId) {
      const owned = db
        .prepare(`SELECT id FROM conversations WHERE id = ? AND user_id = ?`)
        .get(convId, userId);
      if (!owned) {
        res.status(404).json({ error: 'Conversation not found.' });
        return;
      }
    } else {
      convId = crypto.randomUUID();
      const now = new Date().toISOString();
      const title = effectivePrompt.slice(0, 60) + (effectivePrompt.length > 60 ? '...' : '');
      db.prepare(
        `INSERT INTO conversations (id, user_id, title, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`
      ).run(convId, userId, title, requestedModel, now, now);
    }

    const historyRows = db
      .prepare(`SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY created_at ASC LIMIT 24`)
      .all(convId) as Array<{ role: 'user' | 'assistant'; content: string }>;

    const historyForModel = regenerate ? historyRows.slice(0, -1) : historyRows;

    const mode = imageBase64 ? 'image_understand' : 'chat';
    if (!regenerate) {
      db.prepare(
        `INSERT INTO messages (id, conversation_id, role, mode, model, content, media_url, media_mime, cost_inr, created_at)
         VALUES (?, ?, 'user', ?, ?, ?, ?, ?, 0, ?)`
      ).run(
        crypto.randomUUID(),
        convId,
        mode,
        requestedModel,
        effectivePrompt,
        effectiveImageDataUrl || null,
        imageMimeType || null,
        new Date().toISOString()
      );
    }

    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    const abortController = new AbortController();
    res.on('close', () => {
      if (!res.writableEnded) {
        abortController.abort();
      }
    });

    const sendEvent = (payload: Record<string, unknown>) => {
      if (!res.writableEnded) {
        res.write(`data: ${JSON.stringify(payload)}\n\n`);
      }
    };

    sendEvent({ type: 'meta', conversationId: convId, model: requestedModel, mode });

    let fullText = '';
    try {
      for await (const delta of streamChatGeneration({
        model: requestedModel,
        prompt: effectivePrompt,
        history: historyForModel,
        imageBase64,
        imageMimeType,
        signal: abortController.signal,
      })) {
        fullText += delta;
        sendEvent({ type: 'delta', text: delta });
      }

      const trimmed = fullText.trim();
      if (trimmed) {
        const now = new Date().toISOString();
        db.prepare(
          `INSERT INTO messages (id, conversation_id, role, mode, model, content, media_url, media_mime, cost_inr, created_at)
           VALUES (?, ?, 'assistant', ?, ?, ?, NULL, NULL, 0, ?)`
        ).run(crypto.randomUUID(), convId, mode, requestedModel, trimmed, now);
        db.prepare(`UPDATE conversations SET updated_at = ?, model = ? WHERE id = ?`).run(
          now,
          requestedModel,
          convId
        );
        recordUsageIncrement(userId, gate.istDate, feature);
      }

      sendEvent({
        type: 'done',
        conversationId: convId,
        aborted: abortController.signal.aborted,
        membership: getEffectiveMembershipState(userId),
      });
    } catch (err) {
      const normalized = normalizeGeminiError(err);
      logSystemError({
        route: '/api/ai/chat/stream',
        feature,
        userId,
        statusCode: normalized.statusCode,
        errorCode: normalized.code,
        message: normalized.message,
      });
      sendEvent({ type: 'error', error: normalized.message, code: normalized.code });
    } finally {
      if (!res.writableEnded) {
        res.end();
      }
    }
  });

  router.post('/ai/chat', requireAuth, async (req: AuthedRequest, res) => {
    const userId = req.user!.id;
    const prompt = typeof req.body?.prompt === 'string' ? req.body.prompt.trim() : '';
    const requestedModel = 'gemini-4-hydrogen';
    const conversationIdInput =
      typeof req.body?.conversationId === 'string' ? req.body.conversationId.trim() : '';
    const imageDataUrl =
      typeof req.body?.imageDataUrl === 'string' ? req.body.imageDataUrl.trim() : '';

    if (!prompt || prompt.length > 16000) {
      res.status(400).json({ error: 'Prompt must be between 1 and 16,000 characters.' });
      return;
    }

    let imageBase64: string | undefined;
    let imageMimeType: string | undefined;
    if (imageDataUrl) {
      const match = imageDataUrl.match(/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/);
      if (!match) {
        res.status(400).json({ error: 'Invalid image format. Only PNG, JPEG, or WEBP data URLs are allowed.' });
        return;
      }
      if (match[2].length > 7_000_000) {
        res.status(400).json({ error: 'Uploaded image exceeds 5 MB limit.' });
        return;
      }
      imageMimeType = match[1];
      imageBase64 = match[2];
    }

    const feature: FeatureKind = imageBase64 ? 'image_understand' : 'chat_standard';
    const gate = checkFeatureAccess(userId, feature);
    if (!gate.allowed) {
      res.status(gate.statusCode).json({
        error: gate.reason,
        code: gate.code,
        membership: getEffectiveMembershipState(userId),
      });
      return;
    }

    let convId = conversationIdInput;
    if (convId) {
      const owned = db
        .prepare(`SELECT id FROM conversations WHERE id = ? AND user_id = ?`)
        .get(convId, userId);
      if (!owned) {
        res.status(404).json({ error: 'Conversation not found.' });
        return;
      }
    } else {
      convId = crypto.randomUUID();
      const now = new Date().toISOString();
      const title = prompt.slice(0, 60) + (prompt.length > 60 ? '...' : '');
      db.prepare(
        `INSERT INTO conversations (id, user_id, title, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`
      ).run(convId, userId, title, requestedModel, now, now);
    }

    const historyRows = db
      .prepare(`SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY created_at ASC LIMIT 24`)
      .all(convId) as Array<{ role: 'user' | 'assistant'; content: string }>;

    try {
      const result = await runChatGeneration({
        model: requestedModel,
        prompt,
        history: historyRows,
        imageBase64,
        imageMimeType,
      });

      const now = new Date().toISOString();
      const mode = imageBase64 ? 'image_understand' : 'chat';

      db.prepare(
        `INSERT INTO messages (id, conversation_id, role, mode, model, content, media_url, media_mime, cost_inr, created_at)
         VALUES (?, ?, 'user', ?, ?, ?, ?, ?, 0, ?)`
      ).run(
        crypto.randomUUID(),
        convId,
        mode,
        requestedModel,
        prompt,
        imageDataUrl || null,
        imageMimeType || null,
        now
      );

      db.prepare(
        `INSERT INTO messages (id, conversation_id, role, mode, model, content, media_url, media_mime, cost_inr, created_at)
         VALUES (?, ?, 'assistant', ?, ?, ?, NULL, NULL, 0, ?)`
      ).run(crypto.randomUUID(), convId, mode, requestedModel, result.text, now);

      db.prepare(`UPDATE conversations SET updated_at = ?, model = ? WHERE id = ?`).run(
        now,
        requestedModel,
        convId
      );

      recordUsageIncrement(userId, gate.istDate, feature);

      res.json({
        conversationId: convId,
        reply: result.text,
        model: requestedModel,
        mode,
        membership: getEffectiveMembershipState(userId),
      });
    } catch (err) {
      const normalized = normalizeGeminiError(err);
      logSystemError({
        route: '/api/ai/chat',
        feature,
        userId,
        statusCode: normalized.statusCode,
        errorCode: normalized.code,
        message: normalized.message,
      });
      res.status(normalized.statusCode).json({ error: normalized.message, code: normalized.code });
    }
  });

  // ---------------- Image Text Fixer (Detect & Correct Mistakes in Uploaded Images) ----------------
  router.post('/ai/fix-image-text', requireAuth, async (req: AuthedRequest, res) => {
    const userId = req.user!.id;
    const imageDataUrl =
      typeof req.body?.imageDataUrl === 'string' ? req.body.imageDataUrl.trim() : '';
    const customInstruction =
      typeof req.body?.customInstruction === 'string' ? req.body.customInstruction.trim() : '';

    const match = imageDataUrl.match(/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/);
    if (!match) {
      res.status(400).json({ error: 'Invalid image format. Upload a PNG, JPEG, or WEBP image.' });
      return;
    }
    if (match[2].length > 7_000_000) {
      res.status(400).json({ error: 'Uploaded image exceeds 5 MB limit.' });
      return;
    }

    const gate = checkFeatureAccess(userId, 'image_text_fix');
    if (!gate.allowed) {
      res.status(gate.statusCode).json({
        error: gate.reason,
        code: gate.code,
        membership: getEffectiveMembershipState(userId),
      });
      return;
    }

    try {
      const result = await runImageTextFixer({
        imageMimeType: match[1],
        imageBase64: match[2],
        customInstruction,
      });
      recordUsageIncrement(userId, gate.istDate, 'image_text_fix');

      res.json({
        ...result,
        membership: getEffectiveMembershipState(userId),
      });
    } catch (err) {
      const normalized = normalizeGeminiError(err);
      logSystemError({
        route: '/api/ai/fix-image-text',
        feature: 'image_text_fix',
        userId,
        statusCode: normalized.statusCode,
        errorCode: normalized.code,
        message: normalized.message,
      });
      res.status(normalized.statusCode).json({ error: normalized.message, code: normalized.code });
    }
  });

  // ---------------- Voice-Over TTS & Speech Transcription ----------------
  router.post('/ai/voice', requireAuth, async (req: AuthedRequest, res) => {
    const userId = req.user!.id;
    const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
    const voiceName = typeof req.body?.voiceName === 'string' ? req.body.voiceName.trim() : 'Kore';
    const style = typeof req.body?.style === 'string' ? req.body.style.trim() : '';
    const model =
      req.body?.model === 'gemini-3.8-flash-tts'
        ? 'gemini-3.8-flash-tts'
        : 'gemini-3.8-flash-lite-tts';
    const conversationIdInput =
      typeof req.body?.conversationId === 'string' ? req.body.conversationId.trim() : '';

    if (!text || text.length > 4000) {
      res.status(400).json({ error: 'Voice-over script must be between 1 and 4,000 characters.' });
      return;
    }

    const gate = checkFeatureAccess(userId, 'voice_gen');
    if (!gate.allowed) {
      res.status(gate.statusCode).json({
        error: gate.reason,
        code: gate.code,
        membership: getEffectiveMembershipState(userId),
      });
      return;
    }

    let convId = conversationIdInput;
    if (convId) {
      const owned = db
        .prepare(`SELECT id FROM conversations WHERE id = ? AND user_id = ?`)
        .get(convId, userId);
      if (!owned) {
        convId = '';
      }
    }

    try {
      const generated = await runVoiceOverGeneration({ text, voiceName, style, model });
      recordUsageIncrement(userId, gate.istDate, 'voice_gen');

      res.json({
        conversationId: convId || undefined,
        dataUrl: generated.dataUrl,
        mimeType: generated.mimeType,
        voiceName,
        model,
        membership: getEffectiveMembershipState(userId),
      });
    } catch (err) {
      const normalized = normalizeGeminiError(err);
      logSystemError({
        route: '/api/ai/voice',
        feature: 'voice_gen',
        userId,
        statusCode: normalized.statusCode,
        errorCode: normalized.code,
        message: normalized.message,
      });
      res.status(normalized.statusCode).json({ error: normalized.message, code: normalized.code });
    }
  });

  router.post('/ai/transcribe', requireAuth, async (req: AuthedRequest, res) => {
    const userId = req.user!.id;
    const audioDataUrl =
      typeof req.body?.audioDataUrl === 'string' ? req.body.audioDataUrl.trim() : '';

    const match = audioDataUrl.match(
      /^data:(audio\/(?:webm|mp3|mpeg|wav|ogg|mp4)(?:;codecs=[^;]+)?);base64,([A-Za-z0-9+/=]+)$/
    );
    if (!match) {
      res.status(400).json({ error: 'Invalid audio recording payload.' });
      return;
    }

    const mimeType = match[1].split(';')[0];
    const audioBase64 = match[2];
    if (audioBase64.length > 8_000_000) {
      res.status(400).json({ error: 'Audio recording exceeds size limit.' });
      return;
    }

    const gate = checkFeatureAccess(userId, 'voice_transcribe');
    if (!gate.allowed) {
      res.status(gate.statusCode).json({
        error: gate.reason,
        code: gate.code,
        membership: getEffectiveMembershipState(userId),
      });
      return;
    }

    try {
      const result = await runAudioTranscription({ audioBase64, mimeType });
      recordUsageIncrement(userId, gate.istDate, 'voice_transcribe');
      res.json({
        text: result.text,
        membership: getEffectiveMembershipState(userId),
      });
    } catch (err) {
      const normalized = normalizeGeminiError(err);
      logSystemError({
        route: '/api/ai/transcribe',
        feature: 'voice_transcribe',
        userId,
        statusCode: normalized.statusCode,
        errorCode: normalized.code,
        message: normalized.message,
      });
      res.status(normalized.statusCode).json({ error: normalized.message, code: normalized.code });
    }
  });

  // ---------------- Secure Admin Controls (Mohit Jaat) ----------------
  router.get('/admin/status', requireAuth, (req: AuthedRequest, res) => {
    const envPasscodeSet = Boolean(process.env.TEJAS_ADMIN_PASSCODE?.trim());
    const claimed = getAdminAuthRecord();
    res.json({
      isAdmin: req.user!.role === 'admin',
      adminEmail: BRAND_INFO.adminEmail,
      envPasscodeConfigured: envPasscodeSet,
      adminClaimed: Boolean(claimed),
      needsFirstRunBootstrap: !envPasscodeSet && !claimed,
    });
  });

  router.post('/admin/bootstrap', requireAuth, (req: AuthedRequest, res) => {
    const envPasscode = process.env.TEJAS_ADMIN_PASSCODE?.trim();
    if (envPasscode) {
      res.status(409).json({
        error: 'TEJAS_ADMIN_PASSCODE is configured on the server. Use Admin Unlock instead.',
      });
      return;
    }

    const alreadyClaimed = getAdminAuthRecord();
    if (alreadyClaimed) {
      res.status(409).json({
        error: 'Admin access has already been claimed. Please sign in with the admin passcode.',
      });
      return;
    }

    const passcode = typeof req.body?.passcode === 'string' ? req.body.passcode : '';
    if (passcode.length < 8 || passcode.length > 128) {
      res.status(400).json({ error: 'Admin passcode must be between 8 and 128 characters.' });
      return;
    }

    const now = new Date().toISOString();
    const record = {
      hash: hashPassword(passcode),
      claimedByEmail: req.user!.email,
      claimedAt: now,
    };

    const insertRes = db
      .prepare(
        `INSERT OR IGNORE INTO system_settings (key, value_json, updated_at) VALUES ('admin_auth', ?, ?)`
      )
      .run(JSON.stringify(record), now);

    if (insertRes.changes === 0) {
      res.status(409).json({ error: 'Admin access was already claimed concurrently.' });
      return;
    }

    db.prepare(`UPDATE users SET role = 'admin', updated_at = ? WHERE id = ?`).run(now, req.user!.id);
    writeAuditLog(req.user!.id, req.user!.id, 'ADMIN_BOOTSTRAPPED', {
      developer: BRAND_INFO.developer,
      email: req.user!.email,
    });

    const updatedUser = db.prepare(`SELECT * FROM users WHERE id = ?`).get(req.user!.id) as unknown as UserRow;
    res.json({
      ok: true,
      user: sanitizeUser(updatedUser),
      membership: getEffectiveMembershipState(updatedUser.id),
    });
  });

  router.post('/admin/unlock', requireAuth, (req: AuthedRequest, res) => {
    const passcode = typeof req.body?.passcode === 'string' ? req.body.passcode : '';
    if (!passcode) {
      res.status(400).json({ error: 'Admin passcode is required.' });
      return;
    }

    const envPasscode = process.env.TEJAS_ADMIN_PASSCODE?.trim();
    let verified = false;

    if (envPasscode) {
      const a = crypto.createHash('sha256').update(passcode).digest();
      const b = crypto.createHash('sha256').update(envPasscode).digest();
      verified = crypto.timingSafeEqual(a, b);
    } else {
      const claimed = getAdminAuthRecord();
      if (!claimed) {
        res.status(400).json({ error: 'No admin passcode configured yet. Complete First-Run Admin Setup first.' });
        return;
      }
      verified = verifyPassword(passcode, claimed.hash);
    }

    if (!verified) {
      res.status(401).json({ error: 'Invalid admin passcode.' });
      return;
    }

    const now = new Date().toISOString();
    db.prepare(`UPDATE users SET role = 'admin', updated_at = ? WHERE id = ?`).run(now, req.user!.id);
    writeAuditLog(req.user!.id, req.user!.id, 'ADMIN_SESSION_ELEVATED', { email: req.user!.email });

    const updatedUser = db.prepare(`SELECT * FROM users WHERE id = ?`).get(req.user!.id) as unknown as UserRow;
    res.json({
      ok: true,
      user: sanitizeUser(updatedUser),
      membership: getEffectiveMembershipState(updatedUser.id),
    });
  });

  router.get('/admin/overview', requireAdmin, (_req, res) => {
    const settings = getSystemSettings();
    const istDate = getIstDateKey();
    const globalUsage = getGlobalUsageTotals();

    const users = db
      .prepare(
        `SELECT id, email, name, role, is_guest, phone_number, phone_verified, created_at
         FROM users ORDER BY created_at DESC LIMIT 100`
      )
      .all() as Array<{
      id: string;
      email: string;
      name: string;
      role: string;
      is_guest: number;
      phone_number: string | null;
      phone_verified: number;
      created_at: string;
    }>;

    const enrichedUsers = users.map((u) => {
      const usage = db
        .prepare(`SELECT * FROM usage_daily WHERE user_id = ? AND ist_date = ?`)
        .get(u.id, istDate) as
        | {
            chat_count: number;
            image_understand_count: number;
            image_gen_count: number;
            voice_gen_count: number;
            voice_transcribe_count: number;
          }
        | undefined;
      return {
        ...u,
        isGuest: Boolean(u.is_guest),
        phoneVerified: Boolean(u.phone_verified),
        usageToday: {
          chats: usage?.chat_count || 0,
          imageUnderstand: usage?.image_understand_count || 0,
          imageTextFix: usage?.image_gen_count || 0,
          voiceGen: usage?.voice_gen_count || 0,
          voiceTranscribe: usage?.voice_transcribe_count || 0,
        },
      };
    });

    const auditLogs = db
      .prepare(`SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT 50`)
      .all();

    const systemErrors = db
      .prepare(`SELECT * FROM system_errors ORDER BY created_at DESC LIMIT 50`)
      .all();

    res.json({
      summary: {
        totalUsers: enrichedUsers.length,
        istDate,
        dailyChats: globalUsage.dailyChats,
        monthlyChats: globalUsage.monthlyChats,
        systemErrorCount: systemErrors.length,
      },
      settings,
      users: enrichedUsers,
      auditLogs,
      systemErrors,
    });
  });

  router.patch('/admin/settings', requireAdmin, (req: AuthedRequest, res) => {
    const body = (req.body || {}) as Partial<SystemSettings>;
    const updated = updateSystemSettings(body, req.user!.id);
    res.json({ settings: updated });
  });

  router.delete('/admin/errors', requireAdmin, (req: AuthedRequest, res) => {
    db.prepare(`DELETE FROM system_errors`).run();
    writeAuditLog(req.user!.id, null, 'ADMIN_CLEARED_SYSTEM_ERRORS', {});
    res.json({ ok: true });
  });

  router.get('/admin/export-zip', requireAdmin, (req: AuthedRequest, res) => {
    try {
      const zipBuffer = createProjectZipArchive();
      writeAuditLog(req.user!.id, null, 'ADMIN_EXPORTED_PROJECT_ZIP', { bytes: zipBuffer.length });
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', 'attachment; filename="tejas-ai-source.zip"');
      res.setHeader('Content-Length', String(zipBuffer.length));
      res.send(zipBuffer);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to build ZIP archive.' });
    }
  });

  return router;
}

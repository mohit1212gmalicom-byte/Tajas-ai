import crypto from 'node:crypto';
import {
  BRAND_INFO,
  FeatureKind,
  getIstDateKey,
  getIstMonthPrefix,
  getPhoneOtpProviderStatus,
  isGeminiConfigured,
  PLANS,
} from './config.ts';
import { db, writeAuditLog } from './db.ts';

export interface SystemSettings {
  capabilities: {
    enableImageUnderstanding: boolean;
    enableImageTextFixer: boolean;
    enableVoiceOver: boolean;
    enableVoiceInput: boolean;
  };
  aiKillSwitch: boolean;
}

export const DEFAULT_SYSTEM_SETTINGS: SystemSettings = {
  capabilities: {
    enableImageUnderstanding: true,
    enableImageTextFixer: true,
    enableVoiceOver: true,
    enableVoiceInput: true,
  },
  aiKillSwitch: false,
};

export function getSystemSettings(): SystemSettings {
  const row = db.prepare(`SELECT value_json FROM system_settings WHERE key = 'runtime_config'`).get() as
    | { value_json: string }
    | undefined;
  if (!row) {
    const now = new Date().toISOString();
    db.prepare(
      `INSERT OR IGNORE INTO system_settings (key, value_json, updated_at) VALUES (?, ?, ?)`
    ).run('runtime_config', JSON.stringify(DEFAULT_SYSTEM_SETTINGS), now);
    return structuredClone(DEFAULT_SYSTEM_SETTINGS);
  }
  try {
    const parsed = JSON.parse(row.value_json) as Partial<SystemSettings>;
    return {
      capabilities: {
        enableImageUnderstanding: Boolean(
          parsed.capabilities?.enableImageUnderstanding ??
            DEFAULT_SYSTEM_SETTINGS.capabilities.enableImageUnderstanding
        ),
        enableImageTextFixer: Boolean(
          parsed.capabilities?.enableImageTextFixer ??
            DEFAULT_SYSTEM_SETTINGS.capabilities.enableImageTextFixer
        ),
        enableVoiceOver: Boolean(
          parsed.capabilities?.enableVoiceOver ?? DEFAULT_SYSTEM_SETTINGS.capabilities.enableVoiceOver
        ),
        enableVoiceInput: Boolean(
          parsed.capabilities?.enableVoiceInput ?? DEFAULT_SYSTEM_SETTINGS.capabilities.enableVoiceInput
        ),
      },
      aiKillSwitch:
        typeof parsed.aiKillSwitch === 'boolean'
          ? parsed.aiKillSwitch
          : DEFAULT_SYSTEM_SETTINGS.aiKillSwitch,
    };
  } catch {
    return structuredClone(DEFAULT_SYSTEM_SETTINGS);
  }
}

export function updateSystemSettings(partial: Partial<SystemSettings>, actorUserId: string): SystemSettings {
  const current = getSystemSettings();
  const next: SystemSettings = {
    capabilities: {
      enableImageUnderstanding: Boolean(
        partial.capabilities?.enableImageUnderstanding ?? current.capabilities.enableImageUnderstanding
      ),
      enableImageTextFixer: Boolean(
        partial.capabilities?.enableImageTextFixer ?? current.capabilities.enableImageTextFixer
      ),
      enableVoiceOver: Boolean(partial.capabilities?.enableVoiceOver ?? current.capabilities.enableVoiceOver),
      enableVoiceInput: Boolean(partial.capabilities?.enableVoiceInput ?? current.capabilities.enableVoiceInput),
    },
    aiKillSwitch: Boolean(partial.aiKillSwitch ?? current.aiKillSwitch),
  };

  db.prepare(
    `INSERT INTO system_settings (key, value_json, updated_at)
     VALUES ('runtime_config', ?, ?)
     ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`
  ).run(JSON.stringify(next), new Date().toISOString());

  writeAuditLog(actorUserId, null, 'ADMIN_SETTINGS_UPDATED', next as unknown as Record<string, unknown>);
  return next;
}

export interface UsageRow {
  user_id: string;
  ist_date: string;
  chat_count: number;
  premium_chat_count: number;
  image_understand_count: number;
  image_gen_count: number;
  video_gen_count: number;
  voice_gen_count: number;
  voice_transcribe_count: number;
  estimated_cost_inr: number;
  updated_at: string;
}

export function ensureFreeSubscriptionRow(userId: string): void {
  const existing = db
    .prepare(`SELECT id, plan_id FROM subscriptions WHERE user_id = ? LIMIT 1`)
    .get(userId) as { id: string; plan_id: string } | undefined;
  if (existing) {
    if (existing.plan_id !== 'FREE') {
      db.prepare(
        `UPDATE subscriptions SET plan_id = 'FREE', status = 'active', billing_period = 'none', amount_inr = 0, expires_at = NULL, auto_renew = 0, updated_at = ? WHERE user_id = ?`
      ).run(new Date().toISOString(), userId);
    }
    return;
  }

  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO subscriptions (
      id, user_id, plan_id, status, billing_period, amount_inr,
      is_test_mode, auto_renew, started_at, expires_at, cancelled_at, last_payment_id, updated_at
    ) VALUES (?, ?, 'FREE', 'active', 'none', 0, 0, 0, ?, NULL, NULL, NULL, ?)`
  ).run(crypto.randomUUID(), userId, now, now);
}

export function getOrCreateDailyUsage(userId: string, istDate: string = getIstDateKey()): UsageRow {
  const row = db
    .prepare(`SELECT * FROM usage_daily WHERE user_id = ? AND ist_date = ?`)
    .get(userId, istDate) as UsageRow | undefined;
  if (row) return row;

  const now = new Date().toISOString();
  db.prepare(
    `INSERT OR IGNORE INTO usage_daily (
      user_id, ist_date, chat_count, premium_chat_count, image_understand_count,
      image_gen_count, video_gen_count, voice_gen_count, voice_transcribe_count, estimated_cost_inr, updated_at
    ) VALUES (?, ?, 0, 0, 0, 0, 0, 0, 0, 0, ?)`
  ).run(userId, istDate, now);

  return db
    .prepare(`SELECT * FROM usage_daily WHERE user_id = ? AND ist_date = ?`)
    .get(userId, istDate) as unknown as UsageRow;
}

export function getGlobalUsageTotals(): { dailyChats: number; monthlyChats: number } {
  const todayIst = getIstDateKey();
  const monthPrefix = getIstMonthPrefix();
  const daily = db
    .prepare(`SELECT COALESCE(SUM(chat_count), 0) AS total FROM usage_daily WHERE ist_date = ?`)
    .get(todayIst) as { total: number };
  const monthly = db
    .prepare(`SELECT COALESCE(SUM(chat_count), 0) AS total FROM usage_daily WHERE ist_date LIKE ?`)
    .get(`${monthPrefix}%`) as { total: number };
  return {
    dailyChats: Number(daily?.total ?? 0),
    monthlyChats: Number(monthly?.total ?? 0),
  };
}

export function getEffectiveMembershipState(userId: string) {
  ensureFreeSubscriptionRow(userId);
  const settings = getSystemSettings();
  const istDate = getIstDateKey();
  const usage = getOrCreateDailyUsage(userId, istDate);
  const geminiReady = isGeminiConfigured();
  const phoneOtp = getPhoneOtpProviderStatus();
  const freePlan = PLANS.FREE;

  const totalChatsToday = usage.chat_count + usage.premium_chat_count;

  return {
    brand: BRAND_INFO.brand,
    tagline: BRAND_INFO.tagline,
    developer: BRAND_INFO.developer,
    planId: 'FREE' as const,
    planName: freePlan.name,
    priceInr: 0,
    unlimited: true,
    entitlements: freePlan.entitlements,
    providerCapabilities: {
      geminiConfigured: geminiReady,
      aiKillSwitch: settings.aiKillSwitch,
      standardChat: geminiReady && !settings.aiKillSwitch,
      imageUnderstanding:
        geminiReady && !settings.aiKillSwitch && settings.capabilities.enableImageUnderstanding,
      imageTextFixer:
        geminiReady && !settings.aiKillSwitch && settings.capabilities.enableImageTextFixer,
      voiceOverGeneration:
        geminiReady && !settings.aiKillSwitch && settings.capabilities.enableVoiceOver,
      voiceTranscription:
        geminiReady && !settings.aiKillSwitch && settings.capabilities.enableVoiceInput,
      configuredOnServer: {
        imageUnderstanding: geminiReady && settings.capabilities.enableImageUnderstanding,
        imageTextFixer: geminiReady && settings.capabilities.enableImageTextFixer,
        voiceOver: geminiReady && settings.capabilities.enableVoiceOver,
        voiceInput: geminiReady && settings.capabilities.enableVoiceInput,
      },
    },
    usage: {
      istDate,
      totalChatsToday,
      counts: {
        chatStandard: usage.chat_count,
        imageUnderstand: usage.image_understand_count,
        imageTextFix: usage.image_gen_count,
        voiceGen: usage.voice_gen_count,
        voiceTranscribe: usage.voice_transcribe_count || 0,
      },
    },
    phoneOtpProvider: {
      configured: phoneOtp.configured,
      provider: phoneOtp.provider,
    },
  };
}

export function checkFeatureAccess(
  userId: string,
  feature: FeatureKind
): {
  allowed: boolean;
  statusCode: number;
  code: string;
  reason: string;
  istDate: string;
} {
  const state = getEffectiveMembershipState(userId);
  const settings = getSystemSettings();
  const istDate = state.usage.istDate;

  if (settings.aiKillSwitch) {
    return {
      allowed: false,
      statusCode: 503,
      code: 'AI_KILL_SWITCH',
      reason: 'AI services are temporarily paused by administrator Mohit Jaat.',
      istDate,
    };
  }

  const capMap: Record<FeatureKind, boolean> = {
    chat_standard: true,
    image_understand: settings.capabilities.enableImageUnderstanding,
    image_text_fix: settings.capabilities.enableImageTextFixer,
    voice_gen: settings.capabilities.enableVoiceOver,
    voice_transcribe: settings.capabilities.enableVoiceInput,
  };

  if (!capMap[feature]) {
    return {
      allowed: false,
      statusCode: 503,
      code: 'CAPABILITY_DISABLED',
      reason: `Feature "${feature}" is currently disabled in admin settings.`,
      istDate,
    };
  }

  if (!state.providerCapabilities.geminiConfigured) {
    return {
      allowed: false,
      statusCode: 503,
      code: 'PROVIDER_NOT_CONFIGURED',
      reason: 'Gemini provider API key (GEMINI_API_KEY) is not configured on the server.',
      istDate,
    };
  }

  return {
    allowed: true,
    statusCode: 200,
    code: 'OK',
    reason: 'Authorized',
    istDate,
  };
}

export function recordUsageIncrement(userId: string, istDate: string, feature: FeatureKind): void {
  getOrCreateDailyUsage(userId, istDate);
  const colMap: Record<FeatureKind, string> = {
    chat_standard: 'chat_count',
    image_understand: 'image_understand_count',
    image_text_fix: 'image_gen_count',
    voice_gen: 'voice_gen_count',
    voice_transcribe: 'voice_transcribe_count',
  };
  const column = colMap[feature];
  db.prepare(
    `UPDATE usage_daily
     SET ${column} = ${column} + 1,
         updated_at = ?
     WHERE user_id = ? AND ist_date = ?`
  ).run(new Date().toISOString(), userId, istDate);
}

import crypto from 'node:crypto';

export type PlanId = 'FREE';
export type BillingPeriod = 'none';
export type SubscriptionStatus = 'active';

export type FeatureKind =
  | 'chat_standard'
  | 'image_understand'
  | 'image_text_fix'
  | 'voice_gen'
  | 'voice_transcribe';

export interface PlanEntitlements {
  standardChat: boolean;
  imageUnderstanding: boolean;
  imageTextFixer: boolean;
  voiceOverGeneration: boolean;
  voiceTranscription: boolean;
  supportedModels: string[];
}

export interface PlanDefinition {
  id: PlanId;
  name: string;
  priceInr: number;
  billingPeriod: BillingPeriod;
  tagline: string;
  entitlements: PlanEntitlements;
}

export const FREE_ENTITLEMENTS: PlanEntitlements = {
  standardChat: true,
  imageUnderstanding: true,
  imageTextFixer: true,
  voiceOverGeneration: true,
  voiceTranscription: true,
  supportedModels: [
    'gemini-4-hydrogen',
    'gemini-3.8-flash-lite-tts',
    'gemini-3.8-flash-tts',
    'gemini-3.5-transcribe',
  ],
};

export const PLANS: Record<PlanId, PlanDefinition> = {
  FREE: {
    id: 'FREE',
    name: 'FREE',
    priceInr: 0,
    billingPeriod: 'none',
    tagline: 'Unlimited AI Chat, Voice Assistant & Image Text Fixer — 100% Free',
    entitlements: FREE_ENTITLEMENTS,
  },
};

export const BRAND_INFO = {
  brand: 'TEJAS AI',
  tagline: 'भारत का अपना AI साथी',
  developer: 'Mohit Jaat',
  adminEmail: (process.env.ADMIN_EMAIL || 'mohit1212gmali.com@gmail.com').trim().toLowerCase(),
};

const EPHEMERAL_SESSION_SECRET = crypto.randomBytes(32).toString('hex');

export function getSessionSecret(): string {
  const configured = process.env.SESSION_SECRET?.trim();
  return configured && configured.length >= 16 ? configured : EPHEMERAL_SESSION_SECRET;
}

export function isGeminiConfigured(): boolean {
  const key = process.env.GEMINI_API_KEY?.trim();
  return Boolean(key && key !== 'MY_GEMINI_API_KEY' && key.length > 10);
}

export function getPhoneOtpProviderStatus(): {
  configured: boolean;
  provider: string | null;
} {
  const provider = process.env.PHONE_OTP_PROVIDER?.trim() || null;
  const apiKey = process.env.PHONE_OTP_API_KEY?.trim() || null;
  const apiSecret = process.env.PHONE_OTP_API_SECRET?.trim() || null;
  return {
    configured: Boolean(provider && apiKey && apiSecret),
    provider,
  };
}

export function getIstDateKey(date: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

export function getIstMonthPrefix(date: Date = new Date()): string {
  return getIstDateKey(date).slice(0, 7);
}

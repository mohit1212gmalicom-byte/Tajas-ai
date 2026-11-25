export type PlanId = 'FREE';
export type BillingPeriod = 'none';
export type SubscriptionStatus = 'active';

export type WorkspaceView = 'workspace' | 'text_fixer' | 'voice' | 'admin';

export interface UserProfile {
  id: string;
  email: string;
  name: string;
  role: 'user' | 'admin';
  isGuest: boolean;
  phoneNumber: string | null;
  phoneVerified: boolean;
  phoneVerifiedAt: string | null;
  createdAt: string;
}

export interface PlanEntitlements {
  standardChat: boolean;
  imageUnderstanding: boolean;
  imageTextFixer: boolean;
  voiceOverGeneration: boolean;
  voiceTranscription: boolean;
  supportedModels: string[];
}

export interface MembershipState {
  brand: string;
  tagline: string;
  developer: string;
  planId: PlanId;
  planName: string;
  priceInr: number;
  unlimited: boolean;
  entitlements: PlanEntitlements;
  providerCapabilities: {
    geminiConfigured: boolean;
    aiKillSwitch: boolean;
    standardChat: boolean;
    imageUnderstanding: boolean;
    imageTextFixer: boolean;
    voiceOverGeneration: boolean;
    voiceTranscription: boolean;
    configuredOnServer: {
      imageUnderstanding: boolean;
      imageTextFixer: boolean;
      voiceOver: boolean;
      voiceInput: boolean;
    };
  };
  usage: {
    istDate: string;
    totalChatsToday: number;
    counts: {
      chatStandard: number;
      imageUnderstand: number;
      imageTextFix: number;
      voiceGen: number;
      voiceTranscribe: number;
    };
  };
  phoneOtpProvider: {
    configured: boolean;
    provider: string | null;
  };
}

export interface ConversationSummary {
  id: string;
  title: string;
  model: string;
  created_at: string;
  updated_at: string;
}

export interface ChatMessage {
  id: string;
  conversation_id: string;
  role: 'user' | 'assistant';
  mode: 'chat' | 'image_understand' | 'voice_gen';
  model: string | null;
  content: string;
  media_url: string | null;
  media_mime: string | null;
  cost_inr: number;
  created_at: string;
}

export interface ImageTextCorrectionItem {
  originalText: string;
  correctedText: string;
  hasMistake: boolean;
  reason: string;
  ymin: number;
  xmin: number;
  ymax: number;
  xmax: number;
  bgColor: string;
  textColor: string;
  fontWeight: 'normal' | 'bold';
  align: 'left' | 'center' | 'right';
}

export interface ImageTextFixResult {
  summary: string;
  fullExtractedText: string;
  fullCorrectedText: string;
  corrections: ImageTextCorrectionItem[];
  membership?: MembershipState;
}

export interface SystemSettings {
  capabilities: {
    enableImageUnderstanding: boolean;
    enableImageTextFixer: boolean;
    enableVoiceOver: boolean;
    enableVoiceInput: boolean;
  };
  aiKillSwitch: boolean;
}

export interface SystemErrorRow {
  id: string;
  route: string;
  feature: string | null;
  user_id: string | null;
  status_code: number;
  error_code: string | null;
  message: string;
  created_at: string;
}

export interface AdminOverviewData {
  summary: {
    totalUsers: number;
    istDate: string;
    dailyChats: number;
    monthlyChats: number;
    systemErrorCount: number;
  };
  settings: SystemSettings;
  users: Array<{
    id: string;
    email: string;
    name: string;
    role: string;
    isGuest: boolean;
    phoneNumber: string | null;
    phoneVerified: boolean;
    created_at: string;
    usageToday: {
      chats: number;
      imageUnderstand: number;
      imageTextFix: number;
      voiceGen: number;
      voiceTranscribe: number;
    };
  }>;
  auditLogs: Array<{
    id: string;
    actor_user_id: string | null;
    target_user_id: string | null;
    action: string;
    details_json: string;
    created_at: string;
  }>;
  systemErrors: SystemErrorRow[];
}

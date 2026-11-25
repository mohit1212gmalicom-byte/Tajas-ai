import { GoogleGenAI, ThinkingLevel, Type } from '@google/genai';
import { isGeminiConfigured } from './config.ts';

function getAiClient(): GoogleGenAI {
  if (!isGeminiConfigured()) {
    throw new Error('GEMINI_API_KEY is not configured on the server.');
  }
  return new GoogleGenAI({
    apiKey: process.env.GEMINI_API_KEY,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

function extractCleanProviderMessage(err: unknown): string {
  let msg = err instanceof Error ? err.message : String(err);
  for (let depth = 0; depth < 3; depth++) {
    const trimmed = msg.trim();
    if (!trimmed.startsWith('{')) break;
    try {
      const parsed = JSON.parse(trimmed) as { error?: { message?: string }; message?: string };
      const inner = parsed?.error?.message || parsed?.message;
      if (typeof inner === 'string' && inner.trim()) {
        msg = inner.trim();
      } else {
        break;
      }
    } catch {
      break;
    }
  }
  return msg;
}

export function normalizeGeminiError(err: unknown): { statusCode: number; message: string; code: string } {
  const rawMessage = err instanceof Error ? err.message : String(err);
  const cleanMessage = extractCleanProviderMessage(err);
  const upper = `${rawMessage} ${cleanMessage}`.toUpperCase();

  if (upper.includes('PERMISSION_DENIED') || upper.includes('403')) {
    return {
      statusCode: 403,
      code: 'PROVIDER_PERMISSION_DENIED',
      message: 'Configured GEMINI_API_KEY does not have permission for this model. Check Settings > Secrets.',
    };
  }
  if (upper.includes('RESOURCE_EXHAUSTED') || upper.includes('429')) {
    return {
      statusCode: 429,
      code: 'PROVIDER_RATE_LIMITED',
      message: 'AI rate limit temporarily reached (429). Please wait a few seconds and retry.',
    };
  }
  if (upper.includes('API_KEY_INVALID') || upper.includes('401')) {
    return {
      statusCode: 400,
      code: 'PROVIDER_KEY_INVALID',
      message: 'Configured GEMINI_API_KEY is invalid. Check Settings > Secrets.',
    };
  }
  if (upper.includes('NOT_FOUND') || upper.includes('404')) {
    return {
      statusCode: 404,
      code: 'PROVIDER_MODEL_NOT_FOUND',
      message: `Requested model is unavailable on the configured provider key: ${cleanMessage}`,
    };
  }
  if (upper.includes('UNAVAILABLE') || upper.includes('503') || upper.includes('HIGH DEMAND')) {
    return {
      statusCode: 503,
      code: 'PROVIDER_UNAVAILABLE',
      message: 'AI model is experiencing temporary high demand (503). Please click Retry in a few seconds.',
    };
  }
  if (upper.includes('ABORT') || upper.includes('TIMEOUT')) {
    return {
      statusCode: 504,
      code: 'PROVIDER_TIMEOUT',
      message: 'Request timed out waiting for the AI provider. Please retry.',
    };
  }
  return {
    statusCode: 502,
    code: 'PROVIDER_UPSTREAM_ERROR',
    message: `Provider error: ${cleanMessage}`,
  };
}

function isRetryableError(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toUpperCase();
  if (
    msg.includes('PERMISSION_DENIED') ||
    msg.includes('403') ||
    msg.includes('400') ||
    msg.includes('401') ||
    msg.includes('404') ||
    msg.includes('429') ||
    msg.includes('RESOURCE_EXHAUSTED') ||
    msg.includes('API_KEY_INVALID') ||
    msg.includes('ABORT')
  ) {
    return false;
  }
  return (
    msg.includes('503') ||
    msg.includes('UNAVAILABLE') ||
    msg.includes('HIGH DEMAND') ||
    msg.includes('OVERLOADED') ||
    msg.includes('500') ||
    msg.includes('502') ||
    msg.includes('504') ||
    msg.includes('ECONNRESET') ||
    msg.includes('ETIMEDOUT') ||
    msg.includes('FETCH')
  );
}

async function withRetry<T>(fn: () => Promise<T>, maxRetries = 2): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt < maxRetries && isRetryableError(err)) {
        await new Promise((r) => setTimeout(r, 700 * (attempt + 1)));
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

export interface ChatHistoryTurn {
  role: 'user' | 'assistant';
  content: string;
}

const SYSTEM_INSTRUCTION =
  'You are TEJAS AI (भारत का अपना AI साथी), an accurate, intelligent assistant built by Mohit Jaat. Respond fluently in Hindi (Devanagari or Hinglish) or English matching the user language, using clear Markdown and fenced code blocks when helpful.';

function buildChatContents(params: {
  prompt: string;
  history: ChatHistoryTurn[];
  imageBase64?: string;
  imageMimeType?: string;
}) {
  const contents: Array<{ role: 'user' | 'model'; parts: Array<Record<string, unknown>> }> = [];

  for (const turn of params.history.slice(-16)) {
    if (!turn.content) continue;
    contents.push({
      role: turn.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: turn.content }],
    });
  }

  const currentParts: Array<Record<string, unknown>> = [];
  if (params.imageBase64 && params.imageMimeType) {
    currentParts.push({
      inlineData: {
        mimeType: params.imageMimeType,
        data: params.imageBase64,
      },
    });
  }
  currentParts.push({ text: params.prompt });

  contents.push({
    role: 'user',
    parts: currentParts,
  });

  return contents;
}

export async function runChatGeneration(params: {
  model: string;
  prompt: string;
  history: ChatHistoryTurn[];
  imageBase64?: string;
  imageMimeType?: string;
}): Promise<{ text: string }> {
  const ai = getAiClient();
  const contents = buildChatContents(params);

  const attemptModel = async (modelId: string) => {
    const config: Record<string, unknown> = {
      systemInstruction: SYSTEM_INSTRUCTION,
    };
    if (modelId === 'gemini-4-hydrogen') {
      config.thinkingConfig = { thinkingLevel: ThinkingLevel.LOW };
    }
    return withRetry(() =>
      ai.models.generateContent({
        model: modelId,
        contents: contents as never,
        config: config as never,
      })
    );
  };

  let response;
  try {
    response = await attemptModel(params.model);
  } catch (err) {
    if (params.model === 'gemini-4-hydrogen' && isRetryableError(err)) {
      response = await attemptModel('gemini-3.1-flash-lite');
    } else {
      throw err;
    }
  }

  const text = (response.text || '').trim();
  if (!text) {
    throw new Error('Model returned an empty response.');
  }
  return { text };
}

export async function* streamChatGeneration(params: {
  model: string;
  prompt: string;
  history: ChatHistoryTurn[];
  imageBase64?: string;
  imageMimeType?: string;
  signal?: AbortSignal;
}): AsyncGenerator<string> {
  const ai = getAiClient();
  const contents = buildChatContents(params);

  const openStream = async (modelId: string) => {
    const config: Record<string, unknown> = {
      systemInstruction: SYSTEM_INSTRUCTION,
    };
    if (modelId === 'gemini-4-hydrogen') {
      config.thinkingConfig = { thinkingLevel: ThinkingLevel.LOW };
    }
    return withRetry(() =>
      ai.models.generateContentStream({
        model: modelId,
        contents: contents as never,
        config: config as never,
      })
    );
  };

  let responseStream;
  try {
    responseStream = await openStream(params.model);
  } catch (err) {
    if (params.model === 'gemini-4-hydrogen' && isRetryableError(err)) {
      responseStream = await openStream('gemini-3.1-flash-lite');
    } else {
      throw err;
    }
  }

  for await (const chunk of responseStream) {
    if (params.signal?.aborted) {
      break;
    }
    const delta = chunk.text;
    if (delta) {
      yield delta;
    }
  }
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
}

export async function runImageTextFixer(params: {
  imageBase64: string;
  imageMimeType: string;
  customInstruction?: string;
}): Promise<ImageTextFixResult> {
  const ai = getAiClient();

  const userInstruction = params.customInstruction?.trim()
    ? `Inspect all visible text in this image carefully. Find any spelling, grammar, Hindi/Devanagari matra, spacing, or factual/typing errors, AND apply this user request if specified: "${params.customInstruction.trim()}".`
    : 'Inspect all visible text in this image carefully (English, Hindi, Hinglish, numbers). Find every spelling mistake, grammar error, wrong Hindi matra, typo, or broken word.';

  const promptText = `${userInstruction}
For every text line or block you find (especially any with mistakes, plus main visible text lines so the user can edit them if needed), return:
- originalText: exact text currently shown in the image
- correctedText: the fixed, properly spelled text (if no mistake, keep identical to originalText)
- hasMistake: true if originalText has a spelling/grammar/matra/typo error or user requested change, else false
- reason: short explanation of the mistake and correction in Hindi/English (or "Correct as written" if no error)
- ymin, xmin, ymax, xmax: integer bounding box coordinates normalized from 0 to 1000 covering that exact text on the image
- bgColor: hex color (#RRGGBB) of the background immediately behind that text
- textColor: hex color (#RRGGBB) of that text ink
- fontWeight: "bold" or "normal"
- align: "left", "center", or "right"

Also return:
- summary: concise summary of all text errors found and fixed
- fullExtractedText: complete original text from the image
- fullCorrectedText: complete corrected text ready to copy`;

  const attemptFix = async (modelId: string) => {
    const config: Record<string, unknown> = {
      systemInstruction:
        'You are an expert bilingual Hindi & English OCR proofreader and typography inspector. Always return accurate normalized 0-1000 bounding boxes and exact hex colors matching the image.',
      responseMimeType: 'application/json',
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          summary: { type: Type.STRING },
          fullExtractedText: { type: Type.STRING },
          fullCorrectedText: { type: Type.STRING },
          corrections: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                originalText: { type: Type.STRING },
                correctedText: { type: Type.STRING },
                hasMistake: { type: Type.BOOLEAN },
                reason: { type: Type.STRING },
                ymin: { type: Type.INTEGER },
                xmin: { type: Type.INTEGER },
                ymax: { type: Type.INTEGER },
                xmax: { type: Type.INTEGER },
                bgColor: { type: Type.STRING },
                textColor: { type: Type.STRING },
                fontWeight: { type: Type.STRING },
                align: { type: Type.STRING },
              },
            },
          },
        },
      },
    };
    if (modelId === 'gemini-4-hydrogen') {
      config.thinkingConfig = { thinkingLevel: ThinkingLevel.LOW };
    }
    return withRetry(() =>
      ai.models.generateContent({
        model: modelId,
        contents: {
          parts: [
            {
              inlineData: {
                mimeType: params.imageMimeType,
                data: params.imageBase64,
              },
            },
            { text: promptText },
          ],
        },
        config: config as never,
      })
    );
  };

  let response;
  try {
    response = await attemptFix('gemini-4-hydrogen');
  } catch (err) {
    if (isRetryableError(err)) {
      response = await attemptFix('gemini-3.1-flash-lite');
    } else {
      throw err;
    }
  }

  const rawJson = (response.text || '{}').trim();
  const parsed = JSON.parse(rawJson) as Partial<ImageTextFixResult>;

  const sanitizeHex = (val: unknown, fallback: string) =>
    typeof val === 'string' && /^#[0-9a-fA-F]{6}$/.test(val.trim()) ? val.trim() : fallback;
  const clampBox = (val: unknown, fallback: number) => {
    const n = Number(val);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(0, Math.min(1000, Math.round(n)));
  };

  const corrections: ImageTextCorrectionItem[] = Array.isArray(parsed.corrections)
    ? parsed.corrections.slice(0, 30).map((item) => {
        const ymin = clampBox(item?.ymin, 100);
        const xmin = clampBox(item?.xmin, 100);
        const ymax = Math.max(ymin + 12, clampBox(item?.ymax, ymin + 60));
        const xmax = Math.max(xmin + 20, clampBox(item?.xmax, xmin + 200));
        const orig = String(item?.originalText || '').trim();
        const corr = String(item?.correctedText || orig).trim();
        return {
          originalText: orig,
          correctedText: corr,
          hasMistake: Boolean(item?.hasMistake ?? (orig !== corr)),
          reason: String(item?.reason || (orig !== corr ? 'Corrected spelling/grammar' : 'No error detected')),
          ymin,
          xmin,
          ymax: Math.min(1000, ymax),
          xmax: Math.min(1000, xmax),
          bgColor: sanitizeHex(item?.bgColor, '#ffffff'),
          textColor: sanitizeHex(item?.textColor, '#111111'),
          fontWeight: item?.fontWeight === 'bold' ? 'bold' : 'normal',
          align: item?.align === 'center' || item?.align === 'right' ? item.align : 'left',
        };
      })
    : [];

  return {
    summary: String(parsed.summary || 'Image text inspection completed.').trim(),
    fullExtractedText: String(parsed.fullExtractedText || '').trim(),
    fullCorrectedText: String(parsed.fullCorrectedText || '').trim(),
    corrections,
  };
}

export async function runVoiceOverGeneration(params: {
  text: string;
  voiceName?: string;
  style?: string;
  model?: string;
}): Promise<{ dataUrl: string; mimeType: string }> {
  const ai = getAiClient();
  const allowedVoices = new Set(['Puck', 'Charon', 'Kore', 'Fenrir', 'Zephyr']);
  const voiceName = params.voiceName && allowedVoices.has(params.voiceName) ? params.voiceName : 'Kore';
  const model = params.model === 'gemini-3.8-flash-tts' ? 'gemini-3.8-flash-tts' : 'gemini-3.8-flash-lite-tts';

  const response = await withRetry(() =>
    ai.models.generateContent({
      model,
      contents: [
        {
          role: 'user',
          parts: [
            {
              text: params.text,
              speechMetadata: {
                style: params.style?.trim() || 'Clear, crisp studio narrator',
              },
            } as never,
          ],
        },
      ],
      config: {
        responseModalities: ['AUDIO'],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: { voiceName },
          },
        },
      } as never,
    })
  );

  const inline = response.candidates?.[0]?.content?.parts?.[0]?.inlineData;
  if (!inline?.data) {
    throw new Error('Voice-over provider returned no audio output.');
  }
  const mimeType = inline.mimeType || 'audio/wav';
  return {
    dataUrl: `data:${mimeType};base64,${inline.data}`,
    mimeType,
  };
}

export async function runAudioTranscription(params: {
  audioBase64: string;
  mimeType: string;
}): Promise<{ text: string }> {
  const ai = getAiClient();
  const response = await withRetry(() =>
    ai.models.generateContent({
      model: 'gemini-3.5-transcribe',
      contents: {
        parts: [
          {
            inlineData: {
              mimeType: params.mimeType,
              data: params.audioBase64,
            },
          },
          {
            text: 'Transcribe this speech accurately in its original language (Hindi, English, or Hinglish). Return only the transcribed text.',
          },
        ],
      },
    })
  );

  const text = (response.text || '').trim();
  if (!text) {
    throw new Error('No speech could be transcribed from the audio recording.');
  }
  return { text };
}

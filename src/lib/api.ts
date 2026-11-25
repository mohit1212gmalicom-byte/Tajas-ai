import { MembershipState } from '../types/tejas';

let inMemorySessionToken: string | null = null;

export function setInMemorySessionToken(token: string | null): void {
  inMemorySessionToken = token;
}

export class ApiError extends Error {
  status: number;
  code?: string;
  data?: Record<string, unknown>;

  constructor(message: string, status: number, code?: string, data?: Record<string, unknown>) {
    super(message);
    this.status = status;
    this.code = code;
    this.data = data;
  }
}

export async function apiRequest<T>(
  path: string,
  options: RequestInit & { timeoutMs?: number } = {}
): Promise<T> {
  const { timeoutMs = 45000, signal: externalSignal, ...fetchOptions } = options;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const onExternalAbort = () => controller.abort();
  if (externalSignal) {
    if (externalSignal.aborted) {
      controller.abort();
    } else {
      externalSignal.addEventListener('abort', onExternalAbort, { once: true });
    }
  }

  const headers = new Headers(fetchOptions.headers || {});
  headers.set('X-Requested-With', 'TEJAS-AI');
  if (fetchOptions.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  if (inMemorySessionToken && !headers.has('Authorization')) {
    headers.set('Authorization', `Bearer ${inMemorySessionToken}`);
  }

  try {
    const res = await fetch(path, {
      ...fetchOptions,
      headers,
      signal: controller.signal,
      credentials: 'include',
    });

    const text = await res.text();
    let json: Record<string, unknown> = {};
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = { error: text };
      }
    }

    if (!res.ok) {
      const msg =
        typeof json.error === 'string'
          ? json.error
          : `Request failed with status ${res.status}`;
      throw new ApiError(
        msg,
        res.status,
        typeof json.code === 'string' ? json.code : undefined,
        json
      );
    }

    return json as T;
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new ApiError('Request cancelled or timed out. Please retry.', 408, 'REQUEST_TIMEOUT');
    }
    throw err;
  } finally {
    clearTimeout(timer);
    if (externalSignal) {
      externalSignal.removeEventListener('abort', onExternalAbort);
    }
  }
}

export interface StreamChatCallbacks {
  onMeta?: (data: { conversationId: string; model: string; mode: string }) => void;
  onDelta?: (text: string) => void;
  onDone?: (data: { conversationId: string; aborted: boolean; membership: MembershipState }) => void;
}

export async function streamChatRequest(
  payload: Record<string, unknown>,
  callbacks: StreamChatCallbacks,
  signal?: AbortSignal
): Promise<void> {
  const headers = new Headers({
    'Content-Type': 'application/json',
    'X-Requested-With': 'TEJAS-AI',
  });
  if (inMemorySessionToken) {
    headers.set('Authorization', `Bearer ${inMemorySessionToken}`);
  }

  const res = await fetch('/api/ai/chat/stream', {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
    credentials: 'include',
    signal,
  });

  if (!res.ok) {
    const text = await res.text();
    let json: Record<string, unknown> = {};
    try {
      json = JSON.parse(text);
    } catch {
      json = { error: text || `HTTP ${res.status}` };
    }
    throw new ApiError(
      typeof json.error === 'string' ? json.error : `Stream error (${res.status})`,
      res.status,
      typeof json.code === 'string' ? json.code : undefined,
      json
    );
  }

  if (!res.body) {
    throw new ApiError('Response stream unavailable.', 502, 'STREAM_UNAVAILABLE');
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const dataStr = trimmed.slice(5).trim();
      if (!dataStr) continue;
      const event = JSON.parse(dataStr) as {
        type: string;
        conversationId?: string;
        model?: string;
        mode?: string;
        text?: string;
        aborted?: boolean;
        membership?: MembershipState;
        error?: string;
        code?: string;
      };

      if (event.type === 'meta' && event.conversationId) {
        callbacks.onMeta?.({
          conversationId: event.conversationId,
          model: event.model || 'gemini-4-hydrogen',
          mode: event.mode || 'chat',
        });
      } else if (event.type === 'delta' && event.text) {
        callbacks.onDelta?.(event.text);
      } else if (event.type === 'done' && event.conversationId && event.membership) {
        callbacks.onDone?.({
          conversationId: event.conversationId,
          aborted: Boolean(event.aborted),
          membership: event.membership,
        });
      } else if (event.type === 'error') {
        throw new ApiError(event.error || 'Streaming failed.', 502, event.code);
      }
    }
  }
}

export function downloadDataUrl(dataUrl: string, filename: string): void {
  const link = document.createElement('a');
  link.href = dataUrl;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

export async function downloadAuthorizedFile(path: string, filename: string): Promise<void> {
  const headers = new Headers({
    'X-Requested-With': 'TEJAS-AI',
  });
  if (inMemorySessionToken) {
    headers.set('Authorization', `Bearer ${inMemorySessionToken}`);
  }
  const res = await fetch(path, {
    method: 'GET',
    headers,
    credentials: 'include',
  });
  if (!res.ok) {
    const text = await res.text();
    let msg = `Download failed (${res.status})`;
    try {
      const parsed = JSON.parse(text) as { error?: string };
      if (parsed.error) msg = parsed.error;
    } catch {
      // keep fallback
    }
    throw new ApiError(msg, res.status);
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

export function formatIstDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  try {
    return (
      new Intl.DateTimeFormat('en-IN', {
        timeZone: 'Asia/Kolkata',
        day: '2-digit',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        hour12: true,
      }).format(new Date(iso)) + ' IST'
    );
  } catch {
    return iso;
  }
}

export function formatCountdown(targetIso: string, nowMs: number = Date.now()): string {
  const diff = new Date(targetIso).getTime() - nowMs;
  if (diff <= 0) return '00h 00m 00s';
  const totalSec = Math.floor(diff / 1000);
  const hours = Math.floor(totalSec / 3600);
  const mins = Math.floor((totalSec % 3600) / 60);
  const secs = totalSec % 60;
  return `${String(hours).padStart(2, '0')}h ${String(mins).padStart(2, '0')}m ${String(secs).padStart(2, '0')}s`;
}

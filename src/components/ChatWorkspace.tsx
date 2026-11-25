import { useEffect, useRef, useState, type ChangeEvent, type FormEvent, type KeyboardEvent } from 'react';
import {
  AlertTriangle,
  ArrowUp,
  Check,
  Copy,
  FilePenLine,
  Mic,
  MicOff,
  Paperclip,
  RefreshCw,
  RotateCcw,
  Square,
  Volume2,
  X,
} from 'lucide-react';
import { apiRequest, ApiError, streamChatRequest } from '../lib/api';
import { ChatMessage, MembershipState, WorkspaceView } from '../types/tejas';
import { MarkdownContent } from './MarkdownContent';
import { TejasMark } from './TejasMark';

interface ChatWorkspaceProps {
  membership: MembershipState;
  conversationId: string | null;
  messages: ChatMessage[];
  loadingMessages: boolean;
  onMessagesUpdated: (conversationId: string, membership: MembershipState) => void;
  onMembershipUpdated: (membership: MembershipState) => void;
  onNavigate: (view: WorkspaceView) => void;
}

export function ChatWorkspace({
  membership,
  conversationId,
  messages,
  loadingMessages,
  onMessagesUpdated,
  onMembershipUpdated,
  onNavigate,
}: ChatWorkspaceProps) {
  const [prompt, setPrompt] = useState('');
  const [attachedImage, setAttachedImage] = useState<{ dataUrl: string; name: string } | null>(null);
  const [streaming, setStreaming] = useState(false);
  const [streamingText, setStreamingText] = useState('');
  const [optimisticUserText, setOptimisticUserText] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [playingMsgId, setPlayingMsgId] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [errorBanner, setErrorBanner] = useState<{
    message: string;
    canRetry?: boolean;
  } | null>(null);

  const streamAbortRef = useRef<AbortController | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const bottomRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const lastAttemptRef = useRef<{
    prompt: string;
    imageUrl?: string;
  } | null>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, streamingText, optimisticUserText]);

  useEffect(() => {
    return () => {
      streamAbortRef.current?.abort();
      mediaRecorderRef.current?.stop();
    };
  }, []);

  const caps = membership.providerCapabilities;

  function handleFileChange(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
      setErrorBanner({ message: 'Only PNG, JPEG, and WEBP images are supported.' });
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      setErrorBanner({ message: 'Image must be 5 MB or smaller.' });
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        setAttachedImage({ dataUrl: reader.result, name: file.name });
        setErrorBanner(null);
      }
    };
    reader.readAsDataURL(file);
    e.target.value = '';
  }

  async function toggleVoiceInput() {
    if (recording) {
      mediaRecorderRef.current?.stop();
      setRecording(false);
      return;
    }

    if (!navigator.mediaDevices?.getUserMedia) {
      setErrorBanner({
        message: 'Microphone recording is not supported in this browser context.',
      });
      return;
    }

    setErrorBanner(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      audioChunksRef.current = [];

      recorder.ondataavailable = (ev) => {
        if (ev.data.size > 0) audioChunksRef.current.push(ev.data);
      };

      recorder.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(audioChunksRef.current, {
          type: recorder.mimeType || 'audio/webm',
        });
        if (blob.size === 0) return;

        setTranscribing(true);
        try {
          const dataUrl = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result));
            reader.onerror = () => reject(new Error('Failed to read audio recording.'));
            reader.readAsDataURL(blob);
          });

          const res = await apiRequest<{ text: string; membership: MembershipState }>(
            '/api/ai/transcribe',
            {
              method: 'POST',
              body: JSON.stringify({ audioDataUrl: dataUrl }),
            }
          );
          setPrompt((prev) => (prev ? `${prev} ${res.text}` : res.text));
          onMembershipUpdated(res.membership);
        } catch (err) {
          if (err instanceof ApiError && err.data?.membership) {
            onMembershipUpdated(err.data.membership as MembershipState);
          }
          setErrorBanner({
            message: err instanceof Error ? err.message : 'Voice transcription failed.',
          });
        } finally {
          setTranscribing(false);
        }
      };

      mediaRecorderRef.current = recorder;
      recorder.start();
      setRecording(true);
    } catch {
      setErrorBanner({
        message: 'Microphone access denied or unavailable on this device.',
      });
    }
  }

  async function runStream(opts: {
    promptText?: string;
    imageUrl?: string;
    regenerate?: boolean;
  }) {
    if (streaming) return;

    const controller = new AbortController();
    streamAbortRef.current = controller;
    setErrorBanner(null);
    setStreaming(true);
    setStreamingText('');
    if (!opts.regenerate && opts.promptText) {
      setOptimisticUserText(opts.promptText);
    }

    let resolvedConvId = conversationId || '';
    let latestMembership: MembershipState | null = null;

    try {
      await streamChatRequest(
        {
          conversationId: conversationId || undefined,
          prompt: opts.promptText,
          model: 'gemini-4-hydrogen',
          imageDataUrl: opts.imageUrl,
          regenerate: Boolean(opts.regenerate),
        },
        {
          onMeta: (meta) => {
            resolvedConvId = meta.conversationId;
          },
          onDelta: (delta) => {
            setStreamingText((prev) => prev + delta);
          },
          onDone: (done) => {
            resolvedConvId = done.conversationId;
            latestMembership = done.membership;
          },
        },
        controller.signal
      );

      if (!opts.regenerate) {
        setPrompt('');
        setAttachedImage(null);
      }
      if (resolvedConvId && latestMembership) {
        onMessagesUpdated(resolvedConvId, latestMembership);
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        if (resolvedConvId) {
          onMessagesUpdated(resolvedConvId, membership);
        }
      } else if (err instanceof ApiError) {
        const m = err.data?.membership as MembershipState | undefined;
        if (m) onMembershipUpdated(m);
        setErrorBanner({
          message: err.message,
          canRetry: true,
        });
      } else {
        setErrorBanner({
          message: err instanceof Error ? err.message : 'Streaming failed.',
          canRetry: true,
        });
      }
    } finally {
      setStreaming(false);
      setStreamingText('');
      setOptimisticUserText(null);
      streamAbortRef.current = null;
    }
  }

  async function handleSubmit(e?: FormEvent) {
    if (e) e.preventDefault();
    const trimmed = prompt.trim();
    if (!trimmed || streaming) return;

    lastAttemptRef.current = {
      prompt: trimmed,
      imageUrl: attachedImage?.dataUrl,
    };

    await runStream({ promptText: trimmed, imageUrl: attachedImage?.dataUrl });
  }

  function handleStopGeneration() {
    streamAbortRef.current?.abort();
  }

  async function handleCopyMessage(id: string, text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedId(id);
      setTimeout(() => setCopiedId(null), 1600);
    } catch {
      // Ignore clipboard failure
    }
  }

  async function handleListenMessage(id: string, text: string) {
    setPlayingMsgId(id);
    setErrorBanner(null);
    try {
      const res = await apiRequest<{ dataUrl: string; membership: MembershipState }>(
        '/api/ai/voice',
        {
          method: 'POST',
          timeoutMs: 60000,
          body: JSON.stringify({
            text: text.slice(0, 1500),
            voiceName: 'Kore',
            conversationId: conversationId || undefined,
          }),
        }
      );
      onMembershipUpdated(res.membership);
      const audio = new Audio(res.dataUrl);
      audio.onended = () => setPlayingMsgId(null);
      audio.onerror = () => setPlayingMsgId(null);
      await audio.play();
    } catch (err) {
      setPlayingMsgId(null);
      setErrorBanner({
        message: err instanceof Error ? err.message : 'Speech synthesis failed.',
      });
    }
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void handleSubmit();
    }
  }

  const starterPrompts: Array<{ title: string; prompt: string; action?: () => void }> = [
    {
      title: 'Hindi + English AI Chat',
      prompt: 'मुझे भारत में छोटे व्यवसायों के लिए 5 व्यावहारिक AI उपयोग बताएं।',
    },
    {
      title: 'Voice Talk (बोलकर बात करें)',
      prompt: 'Open Voice & Talk Studio to speak with TEJAS AI hands-free.',
      action: () => onNavigate('voice'),
    },
    {
      title: 'Fix Wrong Text in Image',
      prompt: 'Upload an image with spelling or Hindi matra mistakes and download a corrected PNG.',
      action: () => onNavigate('text_fixer'),
    },
    {
      title: 'Coding & Writing Help',
      prompt: 'Write a clean TypeScript helper to format Indian currency (INR) with commas.',
    },
  ];

  return (
    <div className="flex h-full flex-col bg-white text-neutral-900 dark:bg-[#171717] dark:text-neutral-100">
      {/* Compact Header Strip */}
      <div className="border-b border-neutral-200 px-4 py-2 dark:border-neutral-800">
        <div className="mx-auto flex max-w-3xl items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-xs font-medium">
            <span className="rounded-md border border-neutral-300 bg-neutral-100 px-2.5 py-1 dark:border-neutral-700 dark:bg-[#0d0d0d]">
              TEJAS AI · Unlimited Free
            </span>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => onNavigate('voice')}
              className="inline-flex min-h-[32px] items-center gap-1.5 rounded-lg border border-neutral-200 px-2.5 py-1 text-[11px] font-medium hover:bg-neutral-100 dark:border-neutral-800 dark:hover:bg-neutral-800"
            >
              <Mic className="h-3.5 w-3.5" />
              <span>Voice Talk</span>
            </button>
            <button
              type="button"
              onClick={() => onNavigate('text_fixer')}
              className="inline-flex min-h-[32px] items-center gap-1.5 rounded-lg border border-neutral-200 px-2.5 py-1 text-[11px] font-medium hover:bg-neutral-100 dark:border-neutral-800 dark:hover:bg-neutral-800"
            >
              <FilePenLine className="h-3.5 w-3.5" />
              <span>Fix Image Text</span>
            </button>
          </div>
        </div>
      </div>

      {!caps.geminiConfigured && (
        <div className="border-b border-amber-500/30 bg-amber-500/10 px-4 py-2 text-xs text-amber-800 dark:text-amber-300">
          <div className="mx-auto flex max-w-3xl items-center gap-2">
            <AlertTriangle className="h-4 w-4 shrink-0" />
            <span>
              Gemini API is not configured on the server. Set GEMINI_API_KEY in Settings &gt; Secrets to enable live chat, voice, and image text correction.
            </span>
          </div>
        </div>
      )}

      {/* Conversation Thread or Centered Welcome Screen */}
      <div className="flex-1 overflow-y-auto px-4 py-6">
        <div className="mx-auto max-w-3xl space-y-6">
          {loadingMessages ? (
            <div className="space-y-4">
              <div className="h-12 w-2/3 animate-pulse rounded-xl bg-neutral-200 dark:bg-neutral-800" />
              <div className="h-24 w-full animate-pulse rounded-xl bg-neutral-100 dark:bg-neutral-900" />
            </div>
          ) : messages.length === 0 && !optimisticUserText && !streaming ? (
            <div className="flex flex-col items-center justify-center py-8 sm:py-14 text-center">
              <div className="mb-4 rounded-2xl border border-neutral-200 p-3.5 dark:border-neutral-800">
                <TejasMark size={34} />
              </div>
              <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-balance">
                TEJAS AI
              </h1>
              <p className="mt-1 text-sm font-medium text-neutral-600 dark:text-neutral-300">
                भारत का अपना AI साथी
              </p>
              <p className="mt-2 max-w-md text-xs text-neutral-500 dark:text-neutral-400">
                100% Free Unlimited Chat, Hindi &amp; English Voice Assistant, and Image Text Correction.
              </p>

              <div className="mt-8 grid w-full max-w-2xl grid-cols-1 gap-3 sm:grid-cols-2">
                {starterPrompts.map((item) => (
                  <button
                    key={item.title}
                    type="button"
                    onClick={() => {
                      if (item.action) {
                        item.action();
                      } else {
                        setPrompt(item.prompt);
                      }
                    }}
                    className="min-h-[72px] rounded-xl border border-neutral-200 bg-neutral-50 p-4 text-left transition-colors hover:bg-neutral-100 dark:border-neutral-800 dark:bg-[#1f1f1f] dark:hover:bg-neutral-800"
                  >
                    <div className="text-xs font-semibold">{item.title}</div>
                    <div className="mt-1 line-clamp-2 text-xs text-neutral-500 dark:text-neutral-400">
                      {item.prompt}
                    </div>
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <>
              {messages.map((msg, idx) => {
                const isUser = msg.role === 'user';
                const isLastAssistant =
                  !isUser && idx === messages.length - 1 && !streaming;
                return (
                  <div
                    key={msg.id}
                    className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}
                  >
                    <div
                      className={`max-w-[92%] sm:max-w-[85%] space-y-2.5 ${
                        isUser
                          ? 'rounded-2xl bg-neutral-100 px-4 py-3 text-sm text-neutral-900 dark:bg-[#2a2a2a] dark:text-neutral-100'
                          : 'w-full text-sm text-neutral-900 dark:text-neutral-100'
                      }`}
                    >
                      {!isUser && (
                        <div className="flex items-center gap-2 text-xs text-neutral-500 dark:text-neutral-400">
                          <TejasMark size={16} />
                          <span className="font-semibold text-neutral-900 dark:text-neutral-100">
                            TEJAS AI
                          </span>
                        </div>
                      )}

                      {msg.media_url && msg.media_mime?.startsWith('image/') && (
                        <img
                          src={msg.media_url}
                          alt={msg.content || 'Uploaded image'}
                          referrerPolicy="no-referrer"
                          className="max-h-80 rounded-xl border border-neutral-200 object-contain dark:border-neutral-800"
                        />
                      )}

                      {msg.media_url && msg.media_mime?.startsWith('audio/') && (
                        <audio controls src={msg.media_url} className="w-full max-w-md" />
                      )}

                      {isUser ? (
                        <div className="whitespace-pre-wrap break-words">{msg.content}</div>
                      ) : (
                        <MarkdownContent content={msg.content} />
                      )}

                      {!isUser && (
                        <div className="flex flex-wrap items-center gap-1 pt-1">
                          <button
                            type="button"
                            onClick={() => void handleCopyMessage(msg.id, msg.content)}
                            className="inline-flex min-h-[32px] items-center gap-1 rounded-md px-2 py-1 text-[11px] text-neutral-500 hover:bg-neutral-100 hover:text-black dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-white"
                          >
                            {copiedId === msg.id ? (
                              <Check className="h-3.5 w-3.5" />
                            ) : (
                              <Copy className="h-3.5 w-3.5" />
                            )}
                            <span>{copiedId === msg.id ? 'Copied' : 'Copy'}</span>
                          </button>

                          <button
                            type="button"
                            disabled={playingMsgId === msg.id}
                            onClick={() => void handleListenMessage(msg.id, msg.content)}
                            className="inline-flex min-h-[32px] items-center gap-1 rounded-md px-2 py-1 text-[11px] text-neutral-500 hover:bg-neutral-100 hover:text-black disabled:opacity-50 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-white"
                          >
                            <Volume2 className="h-3.5 w-3.5" />
                            <span>{playingMsgId === msg.id ? 'Speaking...' : 'Listen'}</span>
                          </button>

                          {isLastAssistant && (
                            <button
                              type="button"
                              onClick={() => void runStream({ regenerate: true })}
                              className="inline-flex min-h-[32px] items-center gap-1 rounded-md px-2 py-1 text-[11px] text-neutral-500 hover:bg-neutral-100 hover:text-black dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-white"
                            >
                              <RotateCcw className="h-3.5 w-3.5" />
                              <span>Regenerate</span>
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}

              {optimisticUserText && (
                <div className="flex justify-end">
                  <div className="max-w-[85%] rounded-2xl bg-neutral-100 px-4 py-3 text-sm text-neutral-900 dark:bg-[#2a2a2a] dark:text-neutral-100 whitespace-pre-wrap break-words">
                    {optimisticUserText}
                  </div>
                </div>
              )}

              {streaming && (
                <div className="flex justify-start">
                  <div className="w-full space-y-2 text-sm">
                    <div className="flex items-center gap-2 text-xs text-neutral-500 dark:text-neutral-400">
                      <TejasMark size={16} className="animate-pulse" />
                      <span className="font-semibold text-neutral-900 dark:text-neutral-100">
                        TEJAS AI
                      </span>
                    </div>
                    {streamingText ? (
                      <MarkdownContent content={streamingText} />
                    ) : (
                      <div className="text-xs text-neutral-500">Thinking...</div>
                    )}
                  </div>
                </div>
              )}
            </>
          )}
          <div ref={bottomRef} />
        </div>
      </div>

      {/* Bottom Message Composer */}
      <div className="border-t border-neutral-200 px-3 sm:px-4 py-3 sm:py-4 dark:border-neutral-800">
        <div className="mx-auto max-w-3xl space-y-2.5">
          {errorBanner && (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-red-500/40 bg-red-500/10 px-3.5 py-2.5 text-xs text-red-700 dark:text-red-300">
              <span>{errorBanner.message}</span>
              {errorBanner.canRetry && lastAttemptRef.current && (
                <button
                  type="button"
                  onClick={() => {
                    const attempt = lastAttemptRef.current!;
                    void runStream({
                      promptText: attempt.prompt,
                      imageUrl: attempt.imageUrl,
                    });
                  }}
                  className="inline-flex items-center gap-1 rounded-md border border-red-500/40 px-2.5 py-1 font-semibold hover:bg-red-500/20"
                >
                  <RefreshCw className="h-3 w-3" />
                  <span>Retry</span>
                </button>
              )}
            </div>
          )}

          {attachedImage && (
            <div className="flex flex-wrap items-center gap-2">
              <div className="inline-flex items-center gap-2 rounded-lg border border-neutral-300 bg-neutral-100 px-2.5 py-1.5 text-xs dark:border-neutral-700 dark:bg-neutral-900">
                <img
                  src={attachedImage.dataUrl}
                  alt={attachedImage.name}
                  className="h-7 w-7 rounded object-cover"
                />
                <span className="max-w-[160px] truncate">{attachedImage.name}</span>
                <button
                  type="button"
                  onClick={() => setAttachedImage(null)}
                  className="text-neutral-500 hover:text-black dark:hover:text-white"
                  aria-label="Remove attached image"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
              <button
                type="button"
                onClick={() =>
                  setPrompt('Is image mein agar koi text galat likha gaya ho to usko sahi karke batao.')
                }
                className="rounded-lg border border-neutral-300 px-2.5 py-1.5 text-xs font-medium hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-800"
              >
                Check Spelling / Text Mistakes
              </button>
              <button
                type="button"
                onClick={() => onNavigate('text_fixer')}
                className="rounded-lg bg-black px-2.5 py-1.5 text-xs font-medium text-white dark:bg-white dark:text-black"
              >
                Edit &amp; Download Fixed Image
              </button>
            </div>
          )}

          <form
            onSubmit={handleSubmit}
            className="flex items-end gap-2 rounded-2xl border border-neutral-300 bg-neutral-100 px-3 py-2.5 focus-within:border-black dark:border-neutral-700 dark:bg-[#262626] dark:focus-within:border-white"
          >
            <input
              ref={fileInputRef}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              onChange={handleFileChange}
              className="hidden"
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              title="Attach image to read or check text"
              aria-label="Attach image"
              className="inline-flex min-h-[40px] min-w-[40px] items-center justify-center rounded-xl text-neutral-600 hover:bg-neutral-200 hover:text-black dark:text-neutral-300 dark:hover:bg-neutral-700 dark:hover:text-white shrink-0"
            >
              <Paperclip className="h-4 w-4" />
            </button>

            <button
              type="button"
              disabled={transcribing}
              onClick={() => void toggleVoiceInput()}
              title={recording ? 'Stop voice recording' : 'Voice input (Hindi/English)'}
              aria-label={recording ? 'Stop voice recording' : 'Voice input'}
              className={`inline-flex min-h-[40px] min-w-[40px] items-center justify-center rounded-xl transition-colors shrink-0 ${
                recording
                  ? 'bg-red-600 text-white'
                  : 'text-neutral-600 hover:bg-neutral-200 hover:text-black dark:text-neutral-300 dark:hover:bg-neutral-700 dark:hover:text-white'
              }`}
            >
              {recording ? <MicOff className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
            </button>

            <textarea
              rows={2}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={
                transcribing
                  ? 'Transcribing speech...'
                  : 'Ask TEJAS AI anything in Hindi or English (Unlimited Free)...'
              }
              className="max-h-44 flex-1 resize-none bg-transparent py-2 text-sm placeholder:text-neutral-500 focus:outline-none dark:placeholder:text-neutral-400"
            />

            {streaming ? (
              <button
                type="button"
                onClick={handleStopGeneration}
                aria-label="Stop generation"
                title="Stop generation"
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-black text-white transition-opacity hover:opacity-85 dark:bg-white dark:text-black"
              >
                <Square className="h-4 w-4 fill-current" />
              </button>
            ) : (
              <button
                type="submit"
                disabled={!prompt.trim() || transcribing}
                aria-label="Send message"
                title="Send message"
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-black text-white transition-opacity hover:opacity-85 disabled:opacity-30 dark:bg-white dark:text-black"
              >
                <ArrowUp className="h-4 w-4" />
              </button>
            )}
          </form>

          <div className="flex flex-wrap items-center justify-between gap-2 px-1 text-[11px] text-neutral-500 dark:text-neutral-400">
            <span>TEJAS AI · भारत का अपना AI साथी · Mohit Jaat</span>
            <span className="font-mono tabular-nums">
              FREE UNLIMITED · {membership.usage.totalChatsToday} chats today
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

import { useRef, useState, type FormEvent } from 'react';
import {
  AlertTriangle,
  Check,
  Copy,
  Download,
  Mic,
  MicOff,
  RefreshCw,
  Volume2,
} from 'lucide-react';
import { apiRequest, ApiError, downloadDataUrl } from '../lib/api';
import { MembershipState } from '../types/tejas';
import { MarkdownContent } from './MarkdownContent';

interface VoiceStudioPageProps {
  membership: MembershipState;
  onMembershipUpdated: (membership: MembershipState) => void;
}

type VoiceTab = 'voice_talk' | 'voice_over' | 'voice_input';

const VOICES = ['Kore', 'Puck', 'Charon', 'Fenrir', 'Zephyr'];

interface VoiceTurn {
  id: string;
  userText: string;
  assistantText: string;
  audioUrl?: string;
}

export function VoiceStudioPage({
  membership,
  onMembershipUpdated,
}: VoiceStudioPageProps) {
  const [tab, setTab] = useState<VoiceTab>('voice_talk');
  const [selectedVoice, setSelectedVoice] = useState('Kore');
  const [errorMsg, setErrorMsg] = useState('');

  // Voice Talk (Speak -> Transcribe -> AI Reply -> Speak Back)
  const [talkRecording, setTalkRecording] = useState(false);
  const [talkBusyStage, setTalkBusyStage] = useState<'' | 'transcribing' | 'thinking' | 'speaking'>('');
  const [talkConvId, setTalkConvId] = useState<string | undefined>(undefined);
  const [talkTurns, setTalkTurns] = useState<VoiceTurn[]>([]);
  const talkRecorderRef = useRef<MediaRecorder | null>(null);
  const talkChunksRef = useRef<Blob[]>([]);

  // Voice-Over TTS state
  const [ttsText, setTtsText] = useState('');
  const [ttsStyle, setTtsStyle] = useState('Clear, calm studio narrator');
  const [ttsModel, setTtsModel] = useState<'gemini-3.8-flash-lite-tts' | 'gemini-3.8-flash-tts'>(
    'gemini-3.8-flash-lite-tts'
  );
  const [ttsLoading, setTtsLoading] = useState(false);
  const [ttsResult, setTtsResult] = useState<{ dataUrl: string } | null>(null);

  // Voice Input Transcription state
  const [sttRecording, setSttRecording] = useState(false);
  const [sttTranscribing, setSttTranscribing] = useState(false);
  const [transcript, setTranscript] = useState('');
  const [copiedStt, setCopiedStt] = useState(false);
  const sttRecorderRef = useRef<MediaRecorder | null>(null);
  const sttChunksRef = useRef<Blob[]>([]);

  const caps = membership.providerCapabilities;

  async function toggleVoiceTalk() {
    if (talkRecording) {
      talkRecorderRef.current?.stop();
      setTalkRecording(false);
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      setErrorMsg('Microphone recording is unavailable in this browser.');
      return;
    }
    setErrorMsg('');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      talkChunksRef.current = [];
      recorder.ondataavailable = (ev) => {
        if (ev.data.size > 0) talkChunksRef.current.push(ev.data);
      };
      recorder.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(talkChunksRef.current, { type: recorder.mimeType || 'audio/webm' });
        if (blob.size === 0) return;

        try {
          setTalkBusyStage('transcribing');
          const dataUrl = await new Promise<string>((resolve, reject) => {
            const r = new FileReader();
            r.onload = () => resolve(String(r.result));
            r.onerror = () => reject(new Error('Failed to read audio.'));
            r.readAsDataURL(blob);
          });

          const sttRes = await apiRequest<{ text: string; membership: MembershipState }>(
            '/api/ai/transcribe',
            {
              method: 'POST',
              body: JSON.stringify({ audioDataUrl: dataUrl }),
            }
          );
          onMembershipUpdated(sttRes.membership);

          setTalkBusyStage('thinking');
          const chatRes = await apiRequest<{
            conversationId: string;
            reply: string;
            membership: MembershipState;
          }>('/api/ai/chat', {
            method: 'POST',
            timeoutMs: 60000,
            body: JSON.stringify({
              conversationId: talkConvId,
              prompt: sttRes.text,
              model: 'gemini-4-hydrogen',
            }),
          });
          setTalkConvId(chatRes.conversationId);
          onMembershipUpdated(chatRes.membership);

          let replyAudioUrl: string | undefined;
          if (caps.voiceOverGeneration) {
            setTalkBusyStage('speaking');
            try {
              const ttsRes = await apiRequest<{ dataUrl: string; membership: MembershipState }>(
                '/api/ai/voice',
                {
                  method: 'POST',
                  timeoutMs: 60000,
                  body: JSON.stringify({
                    text: chatRes.reply.slice(0, 1200),
                    voiceName: selectedVoice,
                  }),
                }
              );
              replyAudioUrl = ttsRes.dataUrl;
              onMembershipUpdated(ttsRes.membership);
            } catch {
              // Still show text reply even if TTS playback temporarily fails
            }
          }

          setTalkTurns((prev) => [
            {
              id: String(Date.now()),
              userText: sttRes.text,
              assistantText: chatRes.reply,
              audioUrl: replyAudioUrl,
            },
            ...prev,
          ]);

          if (replyAudioUrl) {
            const audio = new Audio(replyAudioUrl);
            void audio.play().catch(() => {
              // Ignore autoplay block on mobile; audio player control is shown
            });
          }
        } catch (err) {
          setErrorMsg(err instanceof Error ? err.message : 'Voice conversation failed.');
        } finally {
          setTalkBusyStage('');
        }
      };
      talkRecorderRef.current = recorder;
      recorder.start();
      setTalkRecording(true);
    } catch {
      setErrorMsg('Microphone permission denied or no audio device found.');
    }
  }

  async function handleVoiceOver(e: FormEvent) {
    e.preventDefault();
    if (!ttsText.trim() || ttsLoading) return;
    setTtsLoading(true);
    setErrorMsg('');
    try {
      const res = await apiRequest<{ dataUrl: string; membership: MembershipState }>(
        '/api/ai/voice',
        {
          method: 'POST',
          timeoutMs: 60000,
          body: JSON.stringify({
            text: ttsText.trim(),
            voiceName: selectedVoice,
            style: ttsStyle,
            model: ttsModel,
          }),
        }
      );
      setTtsResult({ dataUrl: res.dataUrl });
      onMembershipUpdated(res.membership);
    } catch (err) {
      if (err instanceof ApiError && err.data?.membership) {
        onMembershipUpdated(err.data.membership as MembershipState);
      }
      setErrorMsg(err instanceof Error ? err.message : 'Voice-over generation failed.');
    } finally {
      setTtsLoading(false);
    }
  }

  async function toggleSttRecording() {
    if (sttRecording) {
      sttRecorderRef.current?.stop();
      setSttRecording(false);
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      setErrorMsg('Microphone recording is unavailable in this browser.');
      return;
    }
    setErrorMsg('');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      sttChunksRef.current = [];
      recorder.ondataavailable = (ev) => {
        if (ev.data.size > 0) sttChunksRef.current.push(ev.data);
      };
      recorder.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(sttChunksRef.current, { type: recorder.mimeType || 'audio/webm' });
        if (blob.size === 0) return;
        setSttTranscribing(true);
        try {
          const dataUrl = await new Promise<string>((resolve, reject) => {
            const r = new FileReader();
            r.onload = () => resolve(String(r.result));
            r.onerror = () => reject(new Error('Failed to read audio.'));
            r.readAsDataURL(blob);
          });
          const res = await apiRequest<{ text: string; membership: MembershipState }>(
            '/api/ai/transcribe',
            {
              method: 'POST',
              body: JSON.stringify({ audioDataUrl: dataUrl }),
            }
          );
          setTranscript(res.text);
          onMembershipUpdated(res.membership);
        } catch (err) {
          setErrorMsg(err instanceof Error ? err.message : 'Transcription failed.');
        } finally {
          setSttTranscribing(false);
        }
      };
      sttRecorderRef.current = recorder;
      recorder.start();
      setSttRecording(true);
    } catch {
      setErrorMsg('Microphone permission denied or no audio device found.');
    }
  }

  return (
    <div className="h-full overflow-y-auto bg-white px-4 py-8 text-neutral-900 dark:bg-[#171717] dark:text-neutral-100 sm:px-8">
      <div className="mx-auto max-w-4xl space-y-6">
        <div className="border-b border-neutral-200 pb-5 dark:border-neutral-800">
          <div className="text-xs text-neutral-500 dark:text-neutral-400">
            TEJAS AI · Voice Assistant · 100% Free
          </div>
          <h1 className="mt-1 text-2xl sm:text-3xl font-bold tracking-tight">
            Voice &amp; Talk Studio
          </h1>
          <p className="mt-1.5 text-xs text-neutral-600 dark:text-neutral-400">
            बोलकर बात करें (Hindi / English), टेक्स्ट से आवाज़ बनाएं और वॉइस रिकॉर्डिंग को टेक्स्ट में बदलें।
          </p>
        </div>

        {/* Segmented Tabs */}
        <div className="flex flex-wrap gap-1 rounded-xl bg-neutral-100 p-1 dark:bg-[#0d0d0d]">
          {(
            [
              { id: 'voice_talk', label: 'Voice Talk (बोलकर बात करें)' },
              { id: 'voice_over', label: 'Voice-Over (Text -> Audio)' },
              { id: 'voice_input', label: 'Speech-to-Text (STT)' },
            ] as const
          ).map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => {
                setTab(item.id);
                setErrorMsg('');
              }}
              className={`min-h-[38px] flex-1 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors whitespace-nowrap ${
                tab === item.id
                  ? 'bg-white text-black shadow-xs dark:bg-neutral-800 dark:text-white'
                  : 'text-neutral-600 hover:text-black dark:text-neutral-400 dark:hover:text-white'
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>

        {!caps.geminiConfigured && (
          <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-4 text-xs text-amber-900 dark:text-amber-200">
            <div className="flex items-start gap-2">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>
                GEMINI_API_KEY is not configured on the server. Set it in Settings &gt; Secrets to enable live voice features.
              </span>
            </div>
          </div>
        )}

        {errorMsg && (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-red-500/40 bg-red-500/10 px-4 py-3 text-xs text-red-700 dark:text-red-300">
            <span>{errorMsg}</span>
            <button
              type="button"
              onClick={() => setErrorMsg('')}
              className="inline-flex items-center gap-1 font-semibold underline"
            >
              <RefreshCw className="h-3 w-3" /> Dismiss
            </button>
          </div>
        )}

        {/* TAB 1: VOICE TALK */}
        {tab === 'voice_talk' && (
          <div className="space-y-5">
            <div className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-neutral-200 bg-neutral-50 p-6 dark:border-neutral-800 dark:bg-[#121212]">
              <div className="space-y-1">
                <h2 className="text-sm font-semibold">Speak with TEJAS AI (बोलकर बात करें)</h2>
                <p className="text-xs text-neutral-500">
                  Tap <strong>Start Speaking</strong>, ask your question in Hindi or English, then tap <strong>Stop &amp; Send</strong>.
                </p>
              </div>

              <div className="flex flex-wrap items-center gap-3">
                <select
                  value={selectedVoice}
                  onChange={(e) => setSelectedVoice(e.target.value)}
                  aria-label="Assistant Voice"
                  className="min-h-[42px] rounded-lg border border-neutral-300 bg-white px-3 py-2 text-xs dark:border-neutral-700 dark:bg-neutral-900"
                >
                  {VOICES.map((v) => (
                    <option key={v} value={v}>
                      Voice: {v}
                    </option>
                  ))}
                </select>

                <button
                  type="button"
                  disabled={Boolean(talkBusyStage) || !caps.geminiConfigured || !caps.voiceTranscription}
                  onClick={() => void toggleVoiceTalk()}
                  className={`inline-flex min-h-[42px] items-center gap-2 rounded-lg px-5 py-2 text-xs font-semibold disabled:opacity-40 ${
                    talkRecording
                      ? 'bg-red-600 text-white'
                      : 'bg-black text-white dark:bg-white dark:text-black'
                  }`}
                >
                  {talkRecording ? <MicOff className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
                  <span>
                    {talkBusyStage === 'transcribing'
                      ? 'Listening...'
                      : talkBusyStage === 'thinking'
                        ? 'Thinking...'
                        : talkBusyStage === 'speaking'
                          ? 'Generating Voice...'
                          : talkRecording
                            ? 'Stop & Send'
                            : 'Start Speaking'}
                  </span>
                </button>
              </div>
            </div>

            {talkTurns.length === 0 ? (
              <div className="rounded-xl border border-dashed border-neutral-300 bg-neutral-50 p-8 text-center text-xs text-neutral-500 dark:border-neutral-800 dark:bg-[#121212]">
                Your voice conversation history and spoken AI answers will appear here.
              </div>
            ) : (
              <div className="space-y-4">
                {talkTurns.map((turn) => (
                  <div
                    key={turn.id}
                    className="rounded-xl border border-neutral-200 bg-neutral-50 p-4 dark:border-neutral-800 dark:bg-[#121212] space-y-3"
                  >
                    <div className="rounded-lg bg-white px-3.5 py-2.5 text-xs dark:bg-[#1a1a1a]">
                      <span className="font-semibold">You said: </span>
                      <span>{turn.userText}</span>
                    </div>
                    <div className="text-sm">
                      <MarkdownContent content={turn.assistantText} />
                    </div>
                    {turn.audioUrl && (
                      <audio controls src={turn.audioUrl} className="w-full max-w-md" />
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* TAB 2: VOICE-OVER & TTS */}
        {tab === 'voice_over' && (
          <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
            <form
              onSubmit={handleVoiceOver}
              className="space-y-4 rounded-xl border border-neutral-200 bg-neutral-50 p-5 dark:border-neutral-800 dark:bg-[#121212]"
            >
              <div>
                <label className="block text-xs font-semibold">Script (Hindi or English)</label>
                <textarea
                  rows={4}
                  required
                  value={ttsText}
                  onChange={(e) => setTtsText(e.target.value)}
                  placeholder="Enter text to synthesize as WAV speech..."
                  className="mt-1.5 w-full rounded-xl border border-neutral-300 bg-white p-3 text-sm focus:border-black focus:outline-none dark:border-neutral-700 dark:bg-neutral-900 dark:focus:border-white"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[11px] font-medium text-neutral-500">Voice</label>
                  <select
                    value={selectedVoice}
                    onChange={(e) => setSelectedVoice(e.target.value)}
                    className="mt-1 w-full rounded-lg border border-neutral-300 bg-white px-2.5 py-2 text-xs dark:border-neutral-700 dark:bg-neutral-900"
                  >
                    {VOICES.map((v) => (
                      <option key={v} value={v}>
                        {v}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-[11px] font-medium text-neutral-500">Model</label>
                  <select
                    value={ttsModel}
                    onChange={(e) =>
                      setTtsModel(
                        e.target.value as 'gemini-3.8-flash-lite-tts' | 'gemini-3.8-flash-tts'
                      )
                    }
                    className="mt-1 w-full rounded-lg border border-neutral-300 bg-white px-2.5 py-2 text-xs dark:border-neutral-700 dark:bg-neutral-900"
                  >
                    <option value="gemini-3.8-flash-lite-tts">Flash Lite TTS</option>
                    <option value="gemini-3.8-flash-tts">Flash TTS (Expressive)</option>
                  </select>
                </div>
              </div>
              <div>
                <label className="block text-[11px] font-medium text-neutral-500">Delivery Style</label>
                <input
                  type="text"
                  value={ttsStyle}
                  onChange={(e) => setTtsStyle(e.target.value)}
                  className="mt-1 w-full rounded-lg border border-neutral-300 bg-white px-3 py-2 text-xs dark:border-neutral-700 dark:bg-neutral-900"
                />
              </div>
              <button
                type="submit"
                disabled={ttsLoading || !caps.geminiConfigured || !caps.voiceOverGeneration}
                className="inline-flex min-h-[42px] w-full items-center justify-center gap-2 rounded-lg bg-black px-4 py-2.5 text-xs font-semibold text-white disabled:opacity-40 dark:bg-white dark:text-black"
              >
                <Volume2 className="h-4 w-4" />
                <span>{ttsLoading ? 'Generating Audio...' : 'Generate Voice-Over'}</span>
              </button>
            </form>

            <div className="flex flex-col justify-between rounded-xl border border-neutral-200 bg-neutral-50 p-5 dark:border-neutral-800 dark:bg-[#121212]">
              <div className="flex items-center justify-between pb-3">
                <span className="text-xs font-semibold">WAV Audio Output</span>
                {ttsResult && (
                  <button
                    type="button"
                    onClick={() => downloadDataUrl(ttsResult.dataUrl, `tejas-ai-voice-${Date.now()}.wav`)}
                    className="inline-flex items-center gap-1 rounded-lg border border-neutral-300 bg-white px-2.5 py-1 text-xs dark:border-neutral-700 dark:bg-neutral-900"
                  >
                    <Download className="h-3.5 w-3.5" /> Download WAV
                  </button>
                )}
              </div>
              {ttsResult ? (
                <audio controls src={ttsResult.dataUrl} className="w-full" />
              ) : (
                <div className="text-xs text-neutral-500">
                  Generated voice-over audio will appear here for playback and download.
                </div>
              )}
            </div>
          </div>
        )}

        {/* TAB 3: VOICE INPUT TRANSCRIPTION */}
        {tab === 'voice_input' && (
          <div className="rounded-xl border border-neutral-200 bg-neutral-50 p-6 dark:border-neutral-800 dark:bg-[#121212] space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-sm font-semibold">
                  Speech-to-Text Transcription (gemini-3.5-transcribe)
                </h2>
                <p className="mt-0.5 text-xs text-neutral-500">
                  Record Hindi, English, or Hinglish speech using your microphone.
                </p>
              </div>
              <button
                type="button"
                disabled={sttTranscribing || !caps.geminiConfigured || !caps.voiceTranscription}
                onClick={() => void toggleSttRecording()}
                className={`inline-flex min-h-[42px] items-center gap-2 rounded-lg px-4 py-2 text-xs font-semibold disabled:opacity-40 ${
                  sttRecording
                    ? 'bg-red-600 text-white'
                    : 'bg-black text-white dark:bg-white dark:text-black'
                }`}
              >
                {sttRecording ? <MicOff className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
                <span>
                  {sttTranscribing
                    ? 'Transcribing...'
                    : sttRecording
                      ? 'Stop Recording'
                      : 'Start Recording'}
                </span>
              </button>
            </div>

            <div className="rounded-xl border border-neutral-200 bg-white p-4 text-sm dark:border-neutral-800 dark:bg-[#0d0d0d] space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-medium text-neutral-500">Transcript</span>
                {transcript && (
                  <button
                    type="button"
                    onClick={async () => {
                      await navigator.clipboard.writeText(transcript);
                      setCopiedStt(true);
                      setTimeout(() => setCopiedStt(false), 1500);
                    }}
                    className="inline-flex items-center gap-1 rounded border border-neutral-300 px-2 py-0.5 text-[11px] dark:border-neutral-700"
                  >
                    {copiedStt ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
                    <span>{copiedStt ? 'Copied' : 'Copy'}</span>
                  </button>
                )}
              </div>
              <div>{transcript || 'Transcribed text will appear here after recording.'}</div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

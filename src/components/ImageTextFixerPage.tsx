import { useCallback, useEffect, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import {
  AlertTriangle,
  Check,
  Copy,
  Download,
  Eye,
  FilePenLine,
  Plus,
  RefreshCw,
  Trash2,
  Upload,
} from 'lucide-react';
import { apiRequest, ApiError, downloadDataUrl } from '../lib/api';
import { ImageTextCorrectionItem, ImageTextFixResult, MembershipState } from '../types/tejas';

interface ImageTextFixerPageProps {
  membership: MembershipState;
  onMembershipUpdated: (membership: MembershipState) => void;
}

interface EditableCorrection extends ImageTextCorrectionItem {
  id: string;
  enabled: boolean;
}

function sampleEdgeBgColor(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  imgW: number,
  imgH: number,
  fallbackHex: string
): string {
  try {
    const samplePoints: Array<[number, number]> = [
      [Math.max(0, x - 3), Math.max(0, y - 3)],
      [Math.min(imgW - 1, x + w + 2), Math.max(0, y - 3)],
      [Math.max(0, x - 3), Math.min(imgH - 1, y + h + 2)],
      [Math.min(imgW - 1, x + w + 2), Math.min(imgH - 1, y + h + 2)],
    ];
    let r = 0;
    let g = 0;
    let b = 0;
    for (const [sx, sy] of samplePoints) {
      const pixel = ctx.getImageData(Math.round(sx), Math.round(sy), 1, 1).data;
      r += pixel[0];
      g += pixel[1];
      b += pixel[2];
    }
    const count = samplePoints.length;
    return `rgb(${Math.round(r / count)}, ${Math.round(g / count)}, ${Math.round(b / count)})`;
  } catch {
    return fallbackHex;
  }
}

function wrapAndFitText(
  ctx: CanvasRenderingContext2D,
  text: string,
  boxW: number,
  boxH: number,
  fontWeight: 'normal' | 'bold'
): { lines: string[]; fontSize: number; lineHeight: number } {
  const safeW = Math.max(24, boxW - 6);
  const safeH = Math.max(14, boxH - 4);
  const words = text.split(/\s+/).filter(Boolean);

  for (let size = Math.min(96, Math.max(11, Math.floor(safeH * 0.82))); size >= 9; size--) {
    ctx.font = `${fontWeight} ${size}px "Noto Sans Devanagari", Inter, system-ui, sans-serif`;
    const lines: string[] = [];
    let current = '';

    for (const word of words) {
      const candidate = current ? `${current} ${word}` : word;
      if (ctx.measureText(candidate).width <= safeW) {
        current = candidate;
      } else {
        if (current) lines.push(current);
        current = word;
      }
    }
    if (current) lines.push(current);
    if (lines.length === 0) lines.push(text);

    const widest = Math.max(...lines.map((l) => ctx.measureText(l).width));
    const lineHeight = Math.round(size * 1.18);
    const totalH = lines.length * lineHeight;

    if (widest <= safeW + 4 && totalH <= safeH + 6) {
      return { lines, fontSize: size, lineHeight };
    }
  }

  const fallbackSize = 10;
  ctx.font = `${fontWeight} ${fallbackSize}px "Noto Sans Devanagari", Inter, system-ui, sans-serif`;
  return { lines: [text], fontSize: fallbackSize, lineHeight: 12 };
}

export function ImageTextFixerPage({
  membership,
  onMembershipUpdated,
}: ImageTextFixerPageProps) {
  const [uploadedImage, setUploadedImage] = useState<{ dataUrl: string; name: string } | null>(null);
  const [customInstruction, setCustomInstruction] = useState('');
  const [analyzing, setAnalyzing] = useState(false);
  const [result, setResult] = useState<ImageTextFixResult | null>(null);
  const [corrections, setCorrections] = useState<EditableCorrection[]>([]);
  const [showOriginal, setShowOriginal] = useState(false);
  const [copiedText, setCopiedText] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');
  const [fixedDataUrl, setFixedDataUrl] = useState<string>('');

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const caps = membership.providerCapabilities;

  const renderCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || !uploadedImage) return;
    const img = new Image();
    img.onload = () => {
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) return;

      canvas.width = img.naturalWidth || img.width;
      canvas.height = img.naturalHeight || img.height;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

      if (!showOriginal) {
        for (const item of corrections) {
          if (!item.enabled || !item.correctedText.trim()) continue;
          const x = Math.max(0, (item.xmin / 1000) * canvas.width - 3);
          const y = Math.max(0, (item.ymin / 1000) * canvas.height - 2);
          const w = Math.min(canvas.width - x, ((item.xmax - item.xmin) / 1000) * canvas.width + 6);
          const h = Math.min(canvas.height - y, ((item.ymax - item.ymin) / 1000) * canvas.height + 4);

          if (w <= 4 || h <= 4) continue;

          const bgFill = sampleEdgeBgColor(
            ctx,
            x,
            y,
            w,
            h,
            canvas.width,
            canvas.height,
            item.bgColor || '#ffffff'
          );

          ctx.save();
          ctx.fillStyle = bgFill;
          ctx.fillRect(x, y, w, h);

          const { lines, fontSize, lineHeight } = wrapAndFitText(
            ctx,
            item.correctedText,
            w,
            h,
            item.fontWeight
          );

          ctx.font = `${item.fontWeight} ${fontSize}px "Noto Sans Devanagari", Inter, system-ui, sans-serif`;
          ctx.fillStyle = item.textColor || '#111111';
          ctx.textBaseline = 'middle';

          const totalTextH = lines.length * lineHeight;
          const startY = y + h / 2 - totalTextH / 2 + lineHeight / 2;

          lines.forEach((line, idx) => {
            let drawX = x + 4;
            if (item.align === 'center') {
              ctx.textAlign = 'center';
              drawX = x + w / 2;
            } else if (item.align === 'right') {
              ctx.textAlign = 'right';
              drawX = x + w - 4;
            } else {
              ctx.textAlign = 'left';
            }
            ctx.fillText(line, drawX, startY + idx * lineHeight);
          });
          ctx.restore();
        }
      }

      try {
        setFixedDataUrl(canvas.toDataURL('image/png'));
      } catch {
        setFixedDataUrl('');
      }
    };
    img.src = uploadedImage.dataUrl;
  }, [uploadedImage, corrections, showOriginal]);

  useEffect(() => {
    renderCanvas();
  }, [renderCanvas]);

  function handleFileChange(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
      setErrorMsg('Only PNG, JPEG, and WEBP images are supported.');
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      setErrorMsg('Image exceeds 5 MB limit.');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        setUploadedImage({ dataUrl: reader.result, name: file.name });
        setResult(null);
        setCorrections([]);
        setShowOriginal(false);
        setErrorMsg('');
      }
    };
    reader.readAsDataURL(file);
    e.target.value = '';
  }

  async function handleAnalyzeAndFix(e: FormEvent) {
    e.preventDefault();
    if (!uploadedImage || analyzing) return;
    setAnalyzing(true);
    setErrorMsg('');
    try {
      const res = await apiRequest<ImageTextFixResult>('/api/ai/fix-image-text', {
        method: 'POST',
        timeoutMs: 60000,
        body: JSON.stringify({
          imageDataUrl: uploadedImage.dataUrl,
          customInstruction: customInstruction.trim() || undefined,
        }),
      });
      setResult(res);
      setCorrections(
        res.corrections.map((c, idx) => ({
          ...c,
          id: `${idx}-${Date.now()}`,
          enabled: c.hasMistake || c.originalText !== c.correctedText,
        }))
      );
      setShowOriginal(false);
      if (res.membership) {
        onMembershipUpdated(res.membership);
      }
    } catch (err) {
      if (err instanceof ApiError && err.data?.membership) {
        onMembershipUpdated(err.data.membership as MembershipState);
      }
      setErrorMsg(err instanceof Error ? err.message : 'Failed to inspect text in image.');
    } finally {
      setAnalyzing(false);
    }
  }

  function addManualPatch() {
    setCorrections((prev) => [
      ...prev,
      {
        id: `manual-${Date.now()}`,
        originalText: 'Custom region',
        correctedText: 'Corrected text',
        hasMistake: true,
        reason: 'Manual text replacement',
        ymin: 420,
        xmin: 200,
        ymax: 520,
        xmax: 800,
        bgColor: '#ffffff',
        textColor: '#111111',
        fontWeight: 'bold',
        align: 'center',
        enabled: true,
      },
    ]);
  }

  async function handleCopyAllText() {
    const text = result?.fullCorrectedText || corrections.map((c) => c.correctedText).join('\n');
    if (!text) return;
    await navigator.clipboard.writeText(text);
    setCopiedText(true);
    setTimeout(() => setCopiedText(false), 1600);
  }

  const mistakesCount = corrections.filter((c) => c.hasMistake || c.originalText !== c.correctedText).length;

  return (
    <div className="h-full overflow-y-auto bg-white px-4 py-8 text-neutral-900 dark:bg-[#171717] dark:text-neutral-100 sm:px-8">
      <div className="mx-auto max-w-5xl space-y-6">
        <div className="border-b border-neutral-200 pb-5 dark:border-neutral-800">
          <div className="text-xs text-neutral-500 dark:text-neutral-400">
            TEJAS AI · Image Text Correction (इमेज टेक्स्ट सुधार) · 100% Free
          </div>
          <h1 className="mt-1 text-2xl sm:text-3xl font-bold tracking-tight">
            Image Text Fixer
          </h1>
          <p className="mt-1.5 text-xs text-neutral-600 dark:text-neutral-400">
            किसी भी फोटो/स्क्रीनशॉट में गलत लिखा गया टेक्स्ट (English या Hindi मात्रा/स्पेलिंग) ऑटोमेटिक ढूँढें, सही करें और सुधार की हुई इमेज डाउनलोड करें।
          </p>
        </div>

        {!caps.geminiConfigured && (
          <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-4 text-xs text-amber-900 dark:text-amber-200">
            <div className="flex items-start gap-2">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>
                GEMINI_API_KEY is not configured on the server. Set it in Settings &gt; Secrets to enable AI image text inspection.
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

        {/* Upload & Analyze Bar */}
        <form
          onSubmit={handleAnalyzeAndFix}
          className="grid grid-cols-1 gap-4 rounded-xl border border-neutral-200 bg-neutral-50 p-5 dark:border-neutral-800 dark:bg-[#121212] md:grid-cols-3"
        >
          <label className="flex cursor-pointer flex-col items-center justify-center rounded-xl border border-dashed border-neutral-300 bg-white p-4 text-center hover:border-black dark:border-neutral-700 dark:bg-neutral-900 dark:hover:border-white">
            <Upload className="mb-1.5 h-5 w-5 text-neutral-500" />
            <span className="text-xs font-medium truncate max-w-full">
              {uploadedImage ? uploadedImage.name : 'Upload Photo (PNG, JPG, WEBP)'}
            </span>
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp"
              onChange={handleFileChange}
              className="hidden"
            />
          </label>

          <div className="flex flex-col justify-between md:col-span-2 gap-3">
            <div>
              <label className="block text-xs font-semibold">
                Optional Correction Note (क्या सही करना है? — optional)
              </label>
              <input
                type="text"
                value={customInstruction}
                onChange={(e) => setCustomInstruction(e.target.value)}
                placeholder="e.g. Fix spelling mistakes, or change 'Wellcome' to 'Welcome'..."
                className="mt-1.5 w-full rounded-xl border border-neutral-300 bg-white px-3 py-2 text-xs focus:border-black focus:outline-none dark:border-neutral-700 dark:bg-neutral-900 dark:focus:border-white"
              />
            </div>

            <button
              type="submit"
              disabled={!uploadedImage || analyzing || !caps.geminiConfigured || !caps.imageTextFixer}
              className="inline-flex min-h-[42px] w-full items-center justify-center gap-2 rounded-lg bg-black px-4 py-2.5 text-xs font-semibold text-white disabled:opacity-40 dark:bg-white dark:text-black"
            >
              <FilePenLine className="h-4 w-4" />
              <span>
                {analyzing
                  ? 'Checking Text & Fixing Mistakes...'
                  : 'Find Wrong Text & Fix Image'}
              </span>
            </button>
          </div>
        </form>

        {/* Preview + Editable Corrections Grid */}
        {uploadedImage && (
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            {/* Live Canvas Output */}
            <div className="flex flex-col justify-between rounded-xl border border-neutral-200 bg-neutral-50 p-5 dark:border-neutral-800 dark:bg-[#121212] space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-xs font-semibold">
                  {showOriginal ? 'Original Image' : 'Fixed Image Preview'}
                </span>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setShowOriginal((prev) => !prev)}
                    className="inline-flex items-center gap-1 rounded-lg border border-neutral-300 bg-white px-2.5 py-1 text-xs hover:bg-neutral-100 dark:border-neutral-700 dark:bg-neutral-900 dark:hover:bg-neutral-800"
                  >
                    <Eye className="h-3.5 w-3.5" />
                    <span>{showOriginal ? 'Show Fixed' : 'Compare Original'}</span>
                  </button>
                  {fixedDataUrl && (
                    <button
                      type="button"
                      onClick={() =>
                        downloadDataUrl(fixedDataUrl, `tejas-ai-fixed-text-${Date.now()}.png`)
                      }
                      className="inline-flex items-center gap-1 rounded-lg bg-black px-3 py-1 text-xs font-semibold text-white dark:bg-white dark:text-black"
                    >
                      <Download className="h-3.5 w-3.5" />
                      <span>Download Fixed PNG</span>
                    </button>
                  )}
                </div>
              </div>

              <div className="flex items-center justify-center overflow-hidden rounded-xl border border-neutral-200 bg-white p-2 dark:border-neutral-800 dark:bg-[#0d0d0d]">
                <canvas
                  ref={canvasRef}
                  className="max-h-[460px] max-w-full object-contain"
                />
              </div>

              {result && (
                <div className="rounded-xl border border-neutral-200 bg-white p-3.5 text-xs dark:border-neutral-800 dark:bg-[#0d0d0d] space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="font-semibold">
                      Summary ({mistakesCount} mistake{mistakesCount === 1 ? '' : 's'} highlighted)
                    </span>
                    <button
                      type="button"
                      onClick={() => void handleCopyAllText()}
                      className="inline-flex items-center gap-1 rounded border border-neutral-300 px-2 py-0.5 text-[11px] dark:border-neutral-700"
                    >
                      {copiedText ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
                      <span>{copiedText ? 'Copied' : 'Copy Corrected Text'}</span>
                    </button>
                  </div>
                  <p className="text-neutral-600 dark:text-neutral-400">{result.summary}</p>
                  {result.fullCorrectedText && (
                    <pre className="max-h-32 overflow-y-auto whitespace-pre-wrap rounded-lg bg-neutral-100 p-2.5 font-sans text-[11px] dark:bg-neutral-900">
                      {result.fullCorrectedText}
                    </pre>
                  )}
                </div>
              )}
            </div>

            {/* Detected Text Blocks & Manual Editor */}
            <div className="rounded-xl border border-neutral-200 bg-neutral-50 p-5 dark:border-neutral-800 dark:bg-[#121212] space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h2 className="text-sm font-semibold">Detected Text &amp; Corrections</h2>
                  <p className="text-[11px] text-neutral-500">
                    Edit any corrected text or toggle patches to update the image live.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={addManualPatch}
                  className="inline-flex items-center gap-1 rounded-lg border border-neutral-300 bg-white px-2.5 py-1.5 text-xs font-medium hover:bg-neutral-100 dark:border-neutral-700 dark:bg-neutral-900 dark:hover:bg-neutral-800"
                >
                  <Plus className="h-3.5 w-3.5" />
                  <span>Add Custom Fix</span>
                </button>
              </div>

              {corrections.length === 0 ? (
                <div className="rounded-xl border border-dashed border-neutral-300 bg-white p-6 text-center text-xs text-neutral-500 dark:border-neutral-700 dark:bg-[#0d0d0d]">
                  Click <strong>Find Wrong Text &amp; Fix Image</strong> to automatically inspect text spelling &amp; Hindi matras.
                </div>
              ) : (
                <div className="max-h-[540px] space-y-3 overflow-y-auto pr-1">
                  {corrections.map((item) => (
                    <div
                      key={item.id}
                      className="rounded-xl border border-neutral-200 bg-white p-3.5 text-xs dark:border-neutral-800 dark:bg-[#0d0d0d] space-y-2.5"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <label className="flex items-center gap-2 font-medium cursor-pointer">
                          <input
                            type="checkbox"
                            checked={item.enabled}
                            onChange={(e) =>
                              setCorrections((prev) =>
                                prev.map((c) =>
                                  c.id === item.id ? { ...c, enabled: e.target.checked } : c
                                )
                              )
                            }
                          />
                          <span>Apply on image</span>
                          {item.hasMistake && (
                            <span className="rounded bg-black px-1.5 py-0.5 text-[10px] font-semibold text-white dark:bg-white dark:text-black">
                              Mistake Found
                            </span>
                          )}
                        </label>
                        <button
                          type="button"
                          onClick={() =>
                            setCorrections((prev) => prev.filter((c) => c.id !== item.id))
                          }
                          className="text-neutral-400 hover:text-black dark:hover:text-white"
                          aria-label="Remove correction"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>

                      <div className="text-[11px] text-neutral-500">
                        Original: <span className="line-through">{item.originalText || '—'}</span>
                      </div>
                      <div className="text-[11px] text-neutral-600 dark:text-neutral-400">
                        {item.reason}
                      </div>

                      <div>
                        <label className="block text-[11px] font-medium text-neutral-500">
                          Corrected Text
                        </label>
                        <input
                          type="text"
                          value={item.correctedText}
                          onChange={(e) =>
                            setCorrections((prev) =>
                              prev.map((c) =>
                                c.id === item.id ? { ...c, correctedText: e.target.value } : c
                              )
                            )
                          }
                          className="mt-1 w-full rounded-lg border border-neutral-300 bg-neutral-50 px-2.5 py-1.5 text-xs focus:border-black focus:outline-none dark:border-neutral-700 dark:bg-neutral-900 dark:focus:border-white"
                        />
                      </div>

                      <div className="grid grid-cols-3 gap-2 text-[11px]">
                        <div>
                          <label className="block text-neutral-500">Text Color</label>
                          <input
                            type="color"
                            value={item.textColor}
                            onChange={(e) =>
                              setCorrections((prev) =>
                                prev.map((c) =>
                                  c.id === item.id ? { ...c, textColor: e.target.value } : c
                                )
                              )
                            }
                            className="mt-1 h-7 w-full cursor-pointer rounded border border-neutral-300 bg-transparent dark:border-neutral-700"
                          />
                        </div>
                        <div>
                          <label className="block text-neutral-500">Weight</label>
                          <select
                            value={item.fontWeight}
                            onChange={(e) =>
                              setCorrections((prev) =>
                                prev.map((c) =>
                                  c.id === item.id
                                    ? { ...c, fontWeight: e.target.value === 'bold' ? 'bold' : 'normal' }
                                    : c
                                )
                              )
                            }
                            className="mt-1 h-7 w-full rounded border border-neutral-300 bg-white px-1.5 dark:border-neutral-700 dark:bg-neutral-900"
                          >
                            <option value="normal">Normal</option>
                            <option value="bold">Bold</option>
                          </select>
                        </div>
                        <div>
                          <label className="block text-neutral-500">Align</label>
                          <select
                            value={item.align}
                            onChange={(e) =>
                              setCorrections((prev) =>
                                prev.map((c) =>
                                  c.id === item.id
                                    ? {
                                        ...c,
                                        align:
                                          e.target.value === 'center' || e.target.value === 'right'
                                            ? e.target.value
                                            : 'left',
                                      }
                                    : c
                                )
                              )
                            }
                            className="mt-1 h-7 w-full rounded border border-neutral-300 bg-white px-1.5 dark:border-neutral-700 dark:bg-neutral-900"
                          >
                            <option value="left">Left</option>
                            <option value="center">Center</option>
                            <option value="right">Right</option>
                          </select>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

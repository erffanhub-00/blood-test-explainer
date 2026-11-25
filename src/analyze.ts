import {
  ALLOWED_EXTENSIONS,
  ALLOWED_MIMES,
  DISCLAIMER,
  MAX_FILE_SIZE,
  MODEL,
  MODEL_FALLBACKS,
  type AnalysisResult,
  type Env,
  type RawTest,
  type Test,
} from "./types.js";
import { OUTPUT_SCHEMA, SYSTEM_PROMPT, TRANSCRIPTION_SYSTEM_PROMPT, buildPrompt, buildRangeColumnPrompt, buildTranscriptionPrompt, sectionPrompt } from "./prompt.js";
import { countTranscription, filterLimitations, mergeRanges, needsRangesRetry, parseAiOutput, parseRangeColumn, processTests, sanitizeSummary } from "./validation.js";
import { extractPdfText, parsePdfTable, shouldUseDeterministicParse } from "./pdfparse.js";
import { Jimp } from "jimp";
import {
  CALL_BUDGET,
  CALL_TIMEOUT_MS,
  TIME_BUDGET_MS,
  analyzeGaps,
  decideNext,
  roundProgress,
  roundStageName,
  scoreTests,
  type PipelineCtx,
  type StageId,
  type StopReason,
} from "./pipeline.js";

/** Note for the ranges-only retry: the first pass dropped most ranges. */
const RANGES_RETRY_NOTE =
  "در پاسخ قبلی محدوده مرجع بیشتر آزمایش‌ها خالی بود، در حالی که روی برگه برای بیشتر آزمایش‌ها بازه چاپ شده است. این بار فقط محدوده مرجع هر سطر را از ستون Reference Interval بخوان؛ مقدار و واحد را همان‌طور که هست تکرار کن. بازه را null نگذار مگر اینکه در آن سطر واقعاً بازه‌ای چاپ نشده باشد.";

class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=UTF-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function error(message: string, requestId: string, status: number): Response {
  console.error(JSON.stringify({ level: "error", message, requestId }));
  return json({ error: message, requestId }, status);
}

function toBase64(bytes: Uint8Array): string {
  const parts: string[] = [];
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    parts.push(String.fromCharCode(...bytes.subarray(i, i + chunk)));
  }
  return btoa(parts.join(""));
}

function extractMarkdown(result: unknown): string {
  if (Array.isArray(result)) {
    return result.map((i) => (i as { data?: string })?.data ?? "").filter(Boolean).join("\n");
  }
  return typeof result === "string" ? result : ((result as { data?: string })?.data ?? "");
}

function extractText(aiResult: unknown): string {
  if (typeof aiResult === "string") return aiResult;
  const resp = (aiResult as { response?: unknown })?.response;
  if (typeof resp === "string") return resp;
  return (
    (aiResult as { choices?: Array<{ message?: { content?: string } }> })?.choices?.[0]?.message
      ?.content ?? ""
  );
}

type UserContent =
  | string
  | Array<
      | { type: "text"; text: string }
      | { type: "image_url"; image_url: { url: string } }
    >;

type CallOpts = {
  model?: typeof MODEL | (typeof MODEL_FALLBACKS)[number];
  guidedJson?: boolean;
  maxTokens?: number;
  temperature?: number;
  topP?: number;
};

/** One Workers AI call. Throws on empty output; JSON parsing stays with the caller. */
async function callModel(
  env: Env,
  system: string,
  userContent: UserContent,
  opts: CallOpts,
): Promise<string> {
  const aiResult = await env.AI.run(opts.model ?? MODEL, {
    messages: [
      { role: "system", content: system },
      { role: "user", content: userContent },
    ],
    ...(opts.guidedJson ? { guided_json: OUTPUT_SCHEMA } : {}),
    max_tokens: opts.maxTokens ?? 8000,
    temperature: opts.temperature ?? 0.15,
    top_p: opts.topP ?? 0.9,
  });
  const output = extractText(aiResult)
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
  if (!output) throw new Error("empty");
  return output;
}

/** Structured extraction call (JSON, guided by OUTPUT_SCHEMA). */
function callAi(env: Env, userContent: UserContent, opts: CallOpts = {}): Promise<string> {
  return callModel(env, SYSTEM_PROMPT, userContent, { guidedJson: true, maxTokens: 8000, ...opts });
}

/** Plain-text call (no JSON schema): transcription and range-column passes. */
function callText(env: Env, userContent: UserContent, maxTokens = 4000): Promise<string> {
  return callModel(env, TRANSCRIPTION_SYSTEM_PROMPT, userContent, { guidedJson: false, maxTokens });
}

/** Race a promise against a timer. Workers AI takes no abort signal,
 *  so a timeout just lets the pipeline move on; a late result is ignored. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  if (ms <= 0) return Promise.reject(new Error("timeout"));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("timeout")), ms);
  });
  return Promise.race([
    promise.then(
      (v) => { clearTimeout(timer); return v; },
      (e) => { clearTimeout(timer); throw e; },
    ),
    timeout,
  ]);
}

/** One JSON log line per pass: strategy, model, tests returned, ranges
 *  found, round, and wall time. */
function logPass(
  requestId: string,
  pass: string,
  tests: number,
  ranges: number,
  extra?: { model?: string; round?: number; durationMs?: number },
): void {
  console.log(JSON.stringify({
    level: "info", context: "extraction_pass", requestId, pass,
    model: extra?.model ?? MODEL, tests, ranges,
    round: extra?.round, durationMs: extra?.durationMs,
  }));
}

function rangedCount(raw: RawTest[]): number {
  return raw.filter((t) => t.reference_range).length;
}

/** Enhanced variant: normalize + greyscale + sharpen, downscaled only
 *  past 2400px. JPEG data URI, or null when Jimp cannot read it (e.g. WEBP). */
async function enhanceImage(bytes: Uint8Array): Promise<string | null> {
  try {
    const image = await Jimp.read(bytes);
    image.normalize().greyscale();
    if (image.width > 2400) image.resize({ w: 2400 });
    image.convolute([[0, -1, 0], [-1, 5, -1], [0, -1, 0]]);
    const buf = await image.getBuffer("image/jpeg", { quality: 80 });
    return `data:image/jpeg;base64,${toBase64(new Uint8Array(buf))}`;
  } catch {
    return null;
  }
}

interface StageOutcome {
  kind: "json" | "range_column" | "transcription";
  raw: RawTest[];
  transcription?: string;
  summary?: string | null;
  limitations?: string[];
}

interface PipelineInput {
  env: Env;
  requestId: string;
  imageDataUri: string | null;
  bytes: Uint8Array;
  documentText: string;
  isWebp: boolean;
  callTimeoutMs: number;
  timeBudgetMs: number;
  send: (event: Record<string, unknown>) => void;
}

/** The manager loop: ask pipeline.ts what to run next, run that round's
 *  stages concurrently, merge, score, repeat — until goodEnough, the
 *  budget is spent, or no stage can help anymore. Returns the final
 *  result plus the reason the manager stopped. */
async function runPipeline(
  input: PipelineInput,
): Promise<{ result: AnalysisResult; stopReason: StopReason }> {
  const { env, requestId, imageDataUri, bytes, documentText } = input;
  const startedAt = Date.now();
  const elapsed = (): number => Date.now() - startedAt;
  const remainingMs = (): number => input.timeBudgetMs - elapsed();
  const timeoutMs = (): number => Math.min(input.callTimeoutMs, Math.max(0, remainingMs()));

  const reportSuffix = documentText
    ? `\n\nمتن استخراج‌شده از PDF:\n<REPORT>\n${documentText.slice(0, 20000)}\n</REPORT>`
    : "";
  const makeUserContent = (promptText: string): UserContent =>
    imageDataUri
      ? [
          { type: "text", text: promptText },
          { type: "image_url", image_url: { url: imageDataUri } },
        ]
      : promptText;
  const userContent = makeUserContent(buildPrompt() + reportSuffix);

  let callsUsed = 0;
  let stagesRun: StageId[] = [];
  let rawTests: RawTest[] = [];
  let tests: Test[] = [];
  let limitations: string[] = [];
  let summary: string | null = null;
  let modelLimitations: string[] = [];
  let aiOk = false;

  /** Charge the call budget right before an AI invocation. */
  const charge = (n: number): boolean => {
    if (callsUsed + n > CALL_BUDGET) return false;
    callsUsed += n;
    return true;
  };

  /** One AI call with the per-call timeout (capped by the remaining
   *  time budget). Sets aiOk when the call itself answers. */
  async function timed<T>(promise: Promise<T>, label: string): Promise<T> {
    const ms = timeoutMs();
    if (ms <= 0) throw new Error(`timeout:${label}`);
    const out = await withTimeout(promise, ms);
    aiOk = true;
    return out;
  }

  /** Run one stage. A failing or timed-out stage returns null and
   *  never fails the request — the best result so far wins. */
  async function runStage(stage: StageId, roundNo: number): Promise<StageOutcome | null> {
    const started = Date.now();
    const done = (outcome: StageOutcome | null, model?: string): StageOutcome | null => {
      logPass(requestId, stage, outcome ? outcome.raw.length : 0,
        outcome ? rangedCount(outcome.raw) : 0,
        { model, round: roundNo, durationMs: Date.now() - started });
      return outcome;
    };
    try {
      switch (stage) {
        case "full": {
          if (!charge(1)) return done(null);
          const out = await timed(callAi(env, userContent, { maxTokens: 8000 }), "full");
          const parsed = parseAiOutput(out);
          if (!parsed) return done(null);
          return done({ kind: "json", raw: parsed.tests, summary: parsed.summary, limitations: parsed.limitations });
        }
        case "range_column": {
          if (!imageDataUri || !charge(1)) return done(null);
          const text = await timed(callText(env, [
            { type: "text", text: buildRangeColumnPrompt() },
            { type: "image_url", image_url: { url: imageDataUri } },
          ], 1500), "range_column");
          return done({ kind: "range_column", raw: parseRangeColumn(text) });
        }
        case "ranges_only": {
          if (!charge(1)) return done(null);
          const out = await timed(callAi(env, makeUserContent(`${RANGES_RETRY_NOTE}\n\n${buildPrompt()}${reportSuffix}`), { maxTokens: 2000, temperature: 0, topP: 1 }), "ranges_only");
          const parsed = parseAiOutput(out);
          if (!parsed) return done(null);
          return done({ kind: "json", raw: parsed.tests, summary: parsed.summary, limitations: parsed.limitations });
        }
        case "section_hematology":
        case "section_biochemistry": {
          if (!charge(1)) return done(null);
          const section = stage === "section_hematology" ? "hematology" : "biochemistry";
          const out = await timed(callAi(env, makeUserContent(`${sectionPrompt(section)}${reportSuffix}`), { maxTokens: 4000 }), stage);
          const parsed = parseAiOutput(out);
          if (!parsed) return done(null);
          return done({ kind: "json", raw: parsed.tests, summary: parsed.summary, limitations: parsed.limitations });
        }
        case "transcription": {
          if (!imageDataUri || !charge(1)) return done(null);
          const text = await timed(callText(env, [
            { type: "text", text: buildTranscriptionPrompt() },
            { type: "image_url", image_url: { url: imageDataUri } },
          ], 4000), "transcription");
          return done({ kind: "transcription", raw: [], transcription: text });
        }
        case "alt_model_1":
        case "alt_model_2": {
          const idx = stage === "alt_model_1" ? 0 : 1;
          if (!charge(1)) return done(null);
          const model = MODEL_FALLBACKS[idx];
          const out = await timed(callAi(env, userContent, { model, guidedJson: false, maxTokens: 8000 }), stage);
          const parsed = parseAiOutput(out);
          if (!parsed) return done(null, model);
          return done({ kind: "json", raw: parsed.tests, summary: parsed.summary, limitations: parsed.limitations }, model);
        }
        case "enhanced_image": {
          if (!imageDataUri) return done(null);
          const enhanced = await enhanceImage(bytes);
          if (!enhanced) return done(null);
          if (!charge(1)) return done(null);
          const out = await timed(callAi(env, [
            { type: "text", text: buildPrompt() },
            { type: "image_url", image_url: { url: enhanced } },
          ], { maxTokens: 8000 }), stage);
          const parsed = parseAiOutput(out);
          if (!parsed) return done(null);
          return done({ kind: "json", raw: parsed.tests, summary: parsed.summary, limitations: parsed.limitations });
        }
      }
    } catch (e) {
      console.error(JSON.stringify({ level: "error", context: "extraction_pass_failed", requestId, pass: stage, error: e instanceof Error ? e.message : "unknown" }));
      return null;
    }
  }

  /** Merge one round's outcomes. Ranges alone cannot create tests;
   *  a JSON outcome adopts wholesale when the base is still empty. */
  function mergeOutcomes(outcomes: Array<PromiseSettledResult<StageOutcome | null>>): string | null {
    let transcriptionText: string | null = null;
    for (const o of outcomes) {
      if (o.status !== "fulfilled" || !o.value) continue;
      const oc = o.value;
      if (oc.transcription) transcriptionText = oc.transcription;
      if (oc.summary && !summary) summary = oc.summary;
      if (oc.limitations && modelLimitations.length === 0) modelLimitations = oc.limitations;
      if (oc.raw.length === 0) continue;
      if (oc.kind === "range_column" && rawTests.length === 0) continue;
      if (rawTests.length === 0) rawTests = oc.raw;
      else rawTests = mergeRanges(rawTests, oc.raw);
    }
    return transcriptionText;
  }

  function reprocess(): void {
    const done = processTests(rawTests, documentText);
    tests = done.tests;
    limitations = done.limitations;
  }

  let roundNo = 0;
  let stopReason: StopReason = "all_strategies_tried";

  while (true) {
    const score = scoreTests(tests);
    const gaps = analyzeGaps(tests);
    const ctx: PipelineCtx = {
      score,
      stagesRun,
      callsUsed,
      callsBudget: CALL_BUDGET,
      elapsedMs: elapsed(),
      timeBudgetMs: input.timeBudgetMs,
      hasImage: imageDataUri !== null,
      isWebp: input.isWebp,
      lackingSections: gaps.lackingSections,
      valueGapSections: gaps.valueGapSections,
    };
    const decision = decideNext(ctx);
    console.log(JSON.stringify({ level: "info", context: "pipeline_decision", requestId, round: roundNo + 1, action: decision.action, stages: decision.stages, reason: decision.reason, callsUsed, elapsedMs: elapsed() }));
    if (decision.action === "stop") {
      stopReason = decision.reason;
      break;
    }
    stagesRun = [...stagesRun, ...decision.stages];
    roundNo++;
    input.send({
      stage: roundStageName(decision.stages),
      progress: roundProgress(roundNo),
      elapsedSec: Math.floor(elapsed() / 1000),
    });
    const outcomes = await Promise.allSettled(decision.stages.map((s) => runStage(s, roundNo)));
    const transcriptionText = mergeOutcomes(outcomes);
    reprocess();

    // Transcription structuring: one text-only call, only when the
    // transcription has rows and ranges are still missing.
    if (transcriptionText) {
      const counted = countTranscription(transcriptionText);
      if (counted.rows > 0 && needsRangesRetry(tests) && charge(1)) {
        const started = Date.now();
        try {
          const out = await timed(
            callAi(env, `${buildPrompt()}\n\nمتن رونویسی‌شده از برگه:\n<REPORT>\n${transcriptionText.slice(0, 20000)}\n</REPORT>`, { maxTokens: 8000 }),
            "transcription_structure",
          );
          const parsed = parseAiOutput(out);
          logPass(requestId, "transcription_structure", parsed ? parsed.tests.length : 0,
            parsed ? rangedCount(parsed.tests) : 0, { round: roundNo, durationMs: Date.now() - started });
          if (parsed && parsed.tests.length > 0) {
            if (rawTests.length === 0) rawTests = parsed.tests;
            else rawTests = mergeRanges(rawTests, parsed.tests);
            if (parsed.summary && !summary) summary = parsed.summary;
            if (parsed.limitations && modelLimitations.length === 0) modelLimitations = parsed.limitations;
            reprocess();
          }
        } catch {
          // Keep the best result so far; missing ranges stay unknown.
        }
      }
    }

    // Empty result after round 1: the model sometimes returns an empty
    // list on a first pass — retry the full call once.
    if (roundNo === 1 && tests.length === 0 && callsUsed < CALL_BUDGET) {
      const retry = await runStage("full", roundNo);
      if (retry && retry.raw.length > 0) {
        rawTests = retry.raw;
        if (retry.summary && !summary) summary = retry.summary;
        if (retry.limitations && modelLimitations.length === 0) modelLimitations = retry.limitations;
        reprocess();
      }
    }
  }

  if (tests.length === 0) {
    if (!aiOk) throw new ApiError("سرویس هوش مصنوعی در دسترس نیست. لطفاً دوباره تلاش کنید.", 502);
    throw new ApiError("در این فایل آزمایش پیدا نشد. لطفاً برگه آزمایش ارسال کنید.", 422);
  }
  const result: AnalysisResult = {
    summary: sanitizeSummary(summary) || `این گزارش آزمایش خون شامل نتایج ${tests.length} آزمایش است.`,
    tests,
    limitations: [...limitations, ...filterLimitations(modelLimitations, tests)],
    disclaimer: DISCLAIMER,
    requestId,
  };
  console.log(JSON.stringify({
    level: "info", context: "analysis_completed", requestId,
    totalTests: tests.length,
    unknownTests: tests.filter((t) => t.status === "unknown").length,
    stopReason, callsUsed,
  }));
  return { result, stopReason };
}

export async function analyze(
  request: Request,
  env: Env,
  requestId: string,
  opts: { callTimeoutMs?: number; timeBudgetMs?: number } = {},
): Promise<Response> {
  if (!env.AI) return error("اتصال هوش مصنوعی تنظیم نشده است.", requestId, 500);

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return error("فرم ارسالی نامعتبر است.", requestId, 400);
  }

  const file = form.get("file");
  if (!(file instanceof File)) {
    return error("لطفاً یک فایل PDF یا عکس انتخاب کنید.", requestId, 400);
  }
  if (file.size === 0 || file.size > MAX_FILE_SIZE) {
    return error("حجم فایل باید بین ۱ بایت و ۱۰ مگابایت باشد.", requestId, 400);
  }
  const nameLower = file.name.toLowerCase();
  const extOk = ALLOWED_EXTENSIONS.some((ext) => nameLower.endsWith(ext));
  const mimeOk = ALLOWED_MIMES.has(file.type.toLowerCase());
  if (!mimeOk && !extOk) {
    return error("فرمت فایل پشتیبانی نمی‌شود. فقط PDF یا عکس (JPG, PNG, WEBP).", requestId, 400);
  }
  if (nameLower.endsWith(".heic") || nameLower.endsWith(".heif")) {
    return error("فرمت HEIC پشتیبانی نمی‌شود. لطفاً عکس را به JPG تبدیل کنید.", requestId, 400);
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  const isPdf = bytes.length >= 5 && new TextDecoder().decode(bytes.slice(0, 5)) === "%PDF-";
  if (!isPdf && !mimeOk) return error("فایل انتخاب‌شده معتبر نیست.", requestId, 400);

  let documentText = "";
  let imageDataUri: string | null = null;

  if (isPdf) {
    // Deterministic path first: text layer in code (unpdf). A parseable
    // text PDF costs zero AI calls; thin parses go to AI structuring,
    // scanned PDFs (no text) to AI conversion.
    let pdfText = "";
    try {
      pdfText = await extractPdfText(bytes);
    } catch {
      console.log(JSON.stringify({ level: "info", context: "pdf_text_failed", requestId }));
    }
    if (pdfText.trim().length >= 50) {
      documentText = pdfText;
      const parsed = parsePdfTable(pdfText);
      if (shouldUseDeterministicParse(parsed)) {
        const done = processTests(parsed, pdfText);
        console.log(JSON.stringify({
          level: "info", context: "pdf_deterministic", requestId,
          tests: done.tests.length,
          ranged: done.tests.filter((t) => t.reference_range !== null).length,
        }));
        return json({
          summary: `این گزارش آزمایش خون شامل نتایج ${done.tests.length} آزمایش است.`,
          tests: done.tests,
          limitations: done.limitations,
          disclaimer: DISCLAIMER,
          requestId,
        } satisfies AnalysisResult);
      }
    } else {
      if (typeof env.AI.toMarkdown !== "function") {
        return error(
          "قابلیت پردازش PDF در اتصال فعلی در دسترس نیست. لطفاً از عکس استفاده کنید.",
          requestId,
          501,
        );
      }
      try {
        const extracted = await env.AI.toMarkdown([
          { name: file.name || "report.pdf", blob: new Blob([bytes], { type: "application/pdf" }) },
        ]);
        documentText = extractMarkdown(extracted);
      } catch {
        return error("خواندن PDF ناموفق بود. لطفاً از عکس واضح استفاده کنید.", requestId, 422);
      }
      if (documentText.trim().length < 50) {
        return error(
          "متن PDF خوانا نیست؛ عکس واضح برگه را بفرست.",
          requestId,
          422,
        );
      }
    }
  } else {
    imageDataUri = `data:${file.type || "image/jpeg"};base64,${toBase64(bytes)}`;
  }

  const input: PipelineInput = {
    env,
    requestId,
    imageDataUri,
    bytes,
    documentText,
    isWebp: nameLower.endsWith(".webp") || file.type.toLowerCase() === "image/webp",
    callTimeoutMs: opts.callTimeoutMs ?? CALL_TIMEOUT_MS,
    timeBudgetMs: opts.timeBudgetMs ?? TIME_BUDGET_MS,
    send: () => {},
  };

  // Plain JSON mode (fallback when streaming fails): same pipeline,
  // stage events discarded.
  if (new URL(request.url).searchParams.get("stream") === "0") {
    try {
      const { result } = await runPipeline(input);
      return json(result);
    } catch (e) {
      if (e instanceof ApiError) return error(e.message, requestId, e.status);
      throw e;
    }
  }

  // Streaming mode: newline-delimited JSON events — one stage event per
  // round as it actually starts, then {"done": true, "result", "stopReason"}.
  const streamBody = new ReadableStream({
    async start(controller) {
      const enc = new TextEncoder();
      const send = (event: Record<string, unknown>): void => {
        try {
          controller.enqueue(enc.encode(`${JSON.stringify(event)}\n`));
        } catch {
          // Consumer gone; the pipeline still finishes server-side.
        }
      };
      try {
        const { result, stopReason } = await runPipeline({ ...input, send });
        send({ done: true, result, stopReason });
      } catch (e) {
        if (e instanceof ApiError) send({ error: e.message, requestId });
        else send({ error: "خطایی رخ داد. دوباره تلاش کنید.", requestId });
      } finally {
        try {
          controller.close();
        } catch {
          // Already closed.
        }
      }
    },
  });
  return new Response(streamBody, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=UTF-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

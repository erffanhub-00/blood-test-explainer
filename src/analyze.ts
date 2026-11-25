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
  type Section,
  type Test,
} from "./types.js";
import { OUTPUT_SCHEMA, SYSTEM_PROMPT, TRANSCRIPTION_SYSTEM_PROMPT, buildPrompt, buildRangeColumnPrompt, buildTranscriptionPrompt, sectionPrompt } from "./prompt.js";
import { countTranscription, filterLimitations, mergeRanges, needsRangesRetry, parseAiOutput, parseRangeColumn, processTests, sanitizeSummary } from "./validation.js";
import { extractPdfText, parsePdfTable, shouldUseDeterministicParse } from "./pdfparse.js";
import { Jimp } from "jimp";

/** Hard cap on Workers AI calls per request. Worst case the budget
 *  guard skips the last passes; each pass runs only while ranges are
 *  still missing, and early exit keeps the normal case at 1 call. */
const MAX_AI_CALLS = 8;

/** Note for the ranges-only retry: the first pass dropped most ranges. */
const RANGES_RETRY_NOTE =
  "در پاسخ قبلی محدوده مرجع بیشتر آزمایش‌ها خالی بود، در حالی که روی برگه برای بیشتر آزمایش‌ها بازه چاپ شده است. این بار فقط محدوده مرجع هر سطر را از ستون Reference Interval بخوان؛ مقدار و واحد را همان‌طور که هست تکرار کن. بازه را null نگذار مگر اینکه در آن سطر واقعاً بازه‌ای چاپ نشده باشد.";

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

/** One JSON log line per pass: strategy, model, tests returned, ranges found. */
function logPass(requestId: string, pass: string, tests: number, ranges: number, model?: string): void {
  console.log(JSON.stringify({ level: "info", context: "extraction_pass", requestId, pass, model: model ?? MODEL, tests, ranges }));
}

function rangedCount(raw: RawTest[]): number {
  return raw.filter((t) => t.reference_range).length;
}

/** True when a section still has valued tests without a range. */
function sectionNeedsRetry(tests: Test[], section: Section): boolean {
  const valued = tests.filter((t) => t.section === section && t.value !== null);
  return valued.length > 0 && valued.some((t) => t.reference_range === null);
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

export async function analyze(request: Request, env: Env, requestId: string): Promise<Response> {
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

  let aiCalls = 0;
  let output: string;
  try {
    output = await callAi(env, userContent);
    aiCalls++;
  } catch {
    return error("سرویس هوش مصنوعی در دسترس نیست. لطفاً دوباره تلاش کنید.", requestId, 502);
  }

  let data = parseAiOutput(output);
  if (!data) {
    return error("پاسخ هوش مصنوعی قابل پردازش نبود.", requestId, 502);
  }
  if (data.tests.length === 0) {
    // Retry once: the model sometimes returns an empty list on a first pass.
    try {
      output = await callAi(env, userContent);
      aiCalls++;
    } catch {
      return error("سرویس هوش مصنوعی در دسترس نیست. لطفاً دوباره تلاش کنید.", requestId, 502);
    }
    data = parseAiOutput(output);
    if (!data) {
      return error("پاسخ هوش مصنوعی قابل پردازش نبود.", requestId, 502);
    }
    if (data.tests.length === 0) {
      return error("در این فایل آزمایش پیدا نشد. لطفاً برگه آزمایش ارسال کنید.", requestId, 422);
    }
  }

  let rawTests = data.tests;
  let { tests, limitations } = processTests(rawTests, documentText);
  logPass(requestId, "pass1_full", rawTests.length, rangedCount(rawTests));

  // Merge a fallback's raw tests; adopt only when it adds a range.
  function adoptMerged(merged: RawTest[]): boolean {
    const redone = processTests(merged, documentText);
    if (redone.tests.some((t) => t.reference_range !== null)) {
      rawTests = merged;
      tests = redone.tests;
      limitations = redone.limitations;
    }
    return !needsRangesRetry(tests);
  }

  // One fallback JSON pass: merge what it found; a failing pass never
  // fails the request — the best result so far wins.
  async function tryJsonPass(pass: string, content: UserContent, opts: CallOpts = {}): Promise<boolean> {
    if (aiCalls >= MAX_AI_CALLS) return false;
    aiCalls++;
    try {
      const out = await callAi(env, content, opts);
      const parsed = parseAiOutput(out);
      if (!parsed || parsed.tests.length === 0) {
        logPass(requestId, pass, 0, 0, opts.model);
        return false;
      }
      logPass(requestId, pass, parsed.tests.length, rangedCount(parsed.tests), opts.model);
      adoptMerged(mergeRanges(rawTests, parsed.tests));
      return !needsRangesRetry(tests);
    } catch {
      console.error(JSON.stringify({ level: "error", context: "extraction_pass_failed", requestId, pass }));
      return false;
    }
  }

  if (needsRangesRetry(tests)) {
    // Pass 2: ranges-only retry on the same image and prompt.
    const done2 = await tryJsonPass(
      "pass2_ranges_retry",
      makeUserContent(`${RANGES_RETRY_NOTE}\n\n${buildPrompt()}${reportSuffix}`),
    );
    // Pass 3: one section at a time, only where ranges are still missing.
    if (!done2 && needsRangesRetry(tests)) {
      for (const section of ["hematology", "biochemistry"] as const) {
        if (!needsRangesRetry(tests) || !sectionNeedsRetry(tests, section)) continue;
        await tryJsonPass(
          `pass3_${section}`,
          makeUserContent(`${sectionPrompt(section)}${reportSuffix}`),
        );
      }
    }
    // Pass 4 (image only): range-column-only — list ONLY the ranges.
    if (needsRangesRetry(tests) && imageDataUri && aiCalls < MAX_AI_CALLS) {
      aiCalls++;
      try {
        const columnText = await callText(env, [
          { type: "text", text: buildRangeColumnPrompt() },
          { type: "image_url", image_url: { url: imageDataUri } },
        ]);
        const columnRows = parseRangeColumn(columnText);
        logPass(requestId, "pass4_range_column", columnRows.length, columnRows.length);
        if (columnRows.length > 0) adoptMerged(mergeRanges(rawTests, columnRows));
      } catch {
        // Keep the best result so far; missing ranges stay unknown.
      }
    }
    // Pass 5 (image only): transcribe verbatim, then structure the text.
    // Needs 2 calls left in the budget.
    if (needsRangesRetry(tests) && imageDataUri && aiCalls < MAX_AI_CALLS - 1) {
      aiCalls++;
      try {
        const transcription = await callText(env, [
          { type: "text", text: buildTranscriptionPrompt() },
          { type: "image_url", image_url: { url: imageDataUri } },
        ]);
        const counted = countTranscription(transcription);
        logPass(requestId, "pass5_transcribe", counted.rows, counted.ranged);
        if (counted.rows > 0) {
          await tryJsonPass(
            "pass5_structure",
            `${buildPrompt()}\n\nمتن رونویسی‌شده از برگه:\n<REPORT>\n${transcription.slice(0, 20000)}\n</REPORT>`,
          );
        }
      } catch {
        // Keep the best result so far; missing ranges stay unknown.
      }
    }
    // Pass 6: deterministic re-read (temperature 0, top_p 1).
    if (needsRangesRetry(tests)) {
      await tryJsonPass(
        "pass6_deterministic",
        makeUserContent(`${RANGES_RETRY_NOTE}\n\n${buildPrompt()}${reportSuffix}`),
        { temperature: 0, topP: 1 },
      );
    }
    // Pass 7: alternate vision models, one attempt each (no guided_json;
    // Zod validates the JSON instead).
    if (needsRangesRetry(tests)) {
      for (const model of MODEL_FALLBACKS) {
        if (!needsRangesRetry(tests)) break;
        await tryJsonPass(
          `pass7_alt_${model.slice(model.lastIndexOf("/") + 1)}`,
          userContent,
          { model, guidedJson: false },
        );
      }
    }
    // Pass 8 (image only): Jimp-enhanced image, then full extraction.
    if (needsRangesRetry(tests) && imageDataUri && aiCalls < MAX_AI_CALLS) {
      try {
        const enhanced = await enhanceImage(bytes);
        if (enhanced) {
          await tryJsonPass("pass8_enhanced_image", [
            { type: "text", text: buildPrompt() },
            { type: "image_url", image_url: { url: enhanced } },
          ]);
        }
      } catch {
        // Keep the best result so far; missing ranges stay unknown.
      }
    }
  }
  const modelLimitations = data.limitations;
  const summary = sanitizeSummary(data.summary);
  const result: AnalysisResult = {
    summary: summary || `این گزارش آزمایش خون شامل نتایج ${tests.length} آزمایش است.`,
    tests,
    limitations: [...limitations, ...filterLimitations(modelLimitations, tests)],
    disclaimer: DISCLAIMER,
    requestId,
  };
  console.log(
    JSON.stringify({
      level: "info",
      context: "analysis_completed",
      requestId,
      totalTests: tests.length,
      unknownTests: tests.filter((t) => t.status === "unknown").length,
    }),
  );
  return json(result);
}

import {
  ALLOWED_EXTENSIONS,
  ALLOWED_MIMES,
  DISCLAIMER,
  MAX_FILE_SIZE,
  MODEL,
  type AnalysisResult,
  type Env,
  type RawTest,
} from "./types.js";
import { OUTPUT_SCHEMA, SYSTEM_PROMPT, buildPrompt } from "./prompt.js";
import { filterLimitations, mergeRanges, needsRangesRetry, processTests, sanitizeSummary } from "./validation.js";

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

type ParsedOutput = { summary?: unknown; tests?: unknown; limitations?: unknown };

type UserContent =
  | string
  | Array<
      | { type: "text"; text: string }
      | { type: "image_url"; image_url: { url: string } }
    >;

/** One Workers AI call. Throws on empty output; JSON parsing stays with the caller. */
async function callAi(env: Env, userContent: UserContent): Promise<string> {
  const aiResult = await env.AI.run(MODEL, {
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userContent },
    ],
    guided_json: OUTPUT_SCHEMA,
    max_tokens: 8000,
    temperature: 0.15,
    top_p: 0.9,
  });
  const output = extractText(aiResult)
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
  if (!output) throw new Error("empty");
  return output;
}

function parseOutput(output: string): ParsedOutput | null {
  try {
    return JSON.parse(output) as ParsedOutput;
  } catch {
    return null;
  }
}

/** Retry prompt: the first pass dropped most ranges, although the
 *  sheet prints one for most rows. Ask again, for the ranges only. */
function retryRangesPrompt(userContent: UserContent): UserContent {
  const note =
    "در پاسخ قبلی محدوده مرجع بیشتر آزمایش‌ها خالی بود، در حالی که روی برگه برای بیشتر آزمایش‌ها بازه چاپ شده است. این بار فقط محدوده مرجع هر سطر را از ستون Reference Interval بخوان؛ مقدار و واحد را همان‌طور که هست تکرار کن. بازه را null نگذار مگر اینکه در آن سطر واقعاً بازه‌ای چاپ نشده باشد.";
  return typeof userContent === "string"
    ? `${note}\n\n${userContent}`
    : [{ type: "text", text: `${note}\n\n${buildPrompt()}` }, ...userContent.slice(1)];
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
  } else {
    imageDataUri = `data:${file.type || "image/jpeg"};base64,${toBase64(bytes)}`;
  }

  let promptText = buildPrompt();
  if (documentText) {
    promptText += `\n\nمتن استخراج‌شده از PDF:\n<REPORT>\n${documentText.slice(0, 20000)}\n</REPORT>`;
  }
  const userContent: UserContent = imageDataUri
    ? [
        { type: "text", text: promptText },
        { type: "image_url", image_url: { url: imageDataUri } },
      ]
    : promptText;

  let output: string;
  try {
    output = await callAi(env, userContent);
  } catch {
    return error("سرویس هوش مصنوعی در دسترس نیست. لطفاً دوباره تلاش کنید.", requestId, 502);
  }

  let data = parseOutput(output);
  if (!data) {
    return error("پاسخ هوش مصنوعی قابل پردازش نبود.", requestId, 502);
  }
  if (!Array.isArray(data.tests)) {
    return error("ساختار پاسخ هوش مصنوعی نامعتبر است.", requestId, 502);
  }
  if (data.tests.length === 0) {
    // Retry once: the model sometimes returns an empty list on a first pass.
    try {
      output = await callAi(env, userContent);
    } catch {
      return error("سرویس هوش مصنوعی در دسترس نیست. لطفاً دوباره تلاش کنید.", requestId, 502);
    }
    data = parseOutput(output);
    if (!data) {
      return error("پاسخ هوش مصنوعی قابل پردازش نبود.", requestId, 502);
    }
    if (!Array.isArray(data.tests)) {
      return error("ساختار پاسخ هوش مصنوعی نامعتبر است.", requestId, 502);
    }
    if (data.tests.length === 0) {
      return error("در این فایل آزمایش پیدا نشد. لطفاً برگه آزمایش ارسال کنید.", requestId, 422);
    }
  }

  let { tests, limitations } = processTests(data.tests, documentText);
  if (needsRangesRetry(tests)) {
    // Safety net: ranges are systematically missing while values exist,
    // so extraction failed. Retry once for the ranges; only the differential
    // rows genuinely have no range.
    console.log(JSON.stringify({ level: "info", context: "ranges_retry", requestId }));
    try {
      const retryOutput = await callAi(env, retryRangesPrompt(userContent));
      const retryData = parseOutput(retryOutput);
      if (retryData && Array.isArray(retryData.tests) && retryData.tests.length > 0) {
        const merged = mergeRanges(data.tests as RawTest[], retryData.tests as RawTest[]);
        const redone = processTests(merged, documentText);
        if (redone.tests.some((t) => t.reference_range !== null)) {
          tests = redone.tests;
          limitations = redone.limitations;
        }
      }
    } catch {
      // Keep the original result; missing ranges stay unknown, honestly.
    }
  }
  const modelLimitations = Array.isArray(data.limitations)
    ? (data.limitations as unknown[]).filter((x): x is string => typeof x === "string")
    : [];
  const summary = sanitizeSummary(
    typeof data.summary === "string" ? data.summary : null,
  );
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

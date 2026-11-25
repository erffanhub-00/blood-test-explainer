import type { RawTest, Section, Status, Test } from "./types.js";
import { MAX_TESTS } from "./types.js";
import { canonical, fixSpelling } from "./names.js";
import { z } from "zod";

/** Strict boundary check for AI output (Zod guards only the AI boundary;
 *  malformed JSON or wrong shape is a parse failure for the retry path). */
const AiTestSchema = z.object({
  name: z.string().min(1).max(150), abbr: z.string().max(40).nullish(),
  value: z.union([z.string(), z.number()]).nullish(), unit: z.string().max(50).nullish(),
  reference_range: z.string().max(100).nullish(), section: z.string().nullish(),
  definition: z.string().max(300).nullish(),
});

const AiOutputSchema = z.object({
  summary: z.string().nullish(),
  tests: z.array(AiTestSchema).max(MAX_TESTS),
  limitations: z.array(z.string()).nullish(),
});

export function parseAiOutput(output: string): {
  summary: string | null;
  tests: RawTest[];
  limitations: string[];
} | null {
  let data: unknown;
  try {
    data = JSON.parse(output);
  } catch {
    return null;
  }
  const result = AiOutputSchema.safeParse(data);
  if (!result.success) return null;
  return {
    summary: result.data.summary ?? null,
    tests: result.data.tests as RawTest[],
    limitations: result.data.limitations ?? [],
  };
}

/** Persian/Arabic digits → Latin. Runs before any comparison. */
export function normalizeDigits(input: string | number | null | undefined): string | null {
  if (input === null || input === undefined) return null;
  const persian = "۰۱۲۳۴۵۶۷۸۹";
  const arabic = "٠١٢٣٤٥٦٧٨٩";
  return String(input).replace(/[۰-۹٠-٩]/g, (ch) => {
    const p = persian.indexOf(ch);
    if (p !== -1) return String(p);
    return String(arabic.indexOf(ch));
  });
}

export type ParsedRange =
  | { kind: "range"; low: number; high: number }
  | { kind: "max"; max: number }
  | { kind: "min"; min: number };

/** Parse a reference range. Handles "12-16", "12.0 - 16.0", en-dash,
 *  "<200", ">70", "up to 200", "(12-16)" and trailing units.
 *  Returns null when it cannot be parsed — never guess. */
export function parseRange(input: string | null): ParsedRange | null {
  if (!input) return null;
  let s = normalizeDigits(input)!.replace(/\s+/g, " ").trim();
  // "(12-16)" or "12-16 (mg/dL)": keep the leading range part.
  if (s.startsWith("(")) s = s.replace(/^\(\s*/, "").replace(/\)\s*$/, "");
  s = s.replace(/\s*\(.*$/, "");

  const lt = s.match(/^<\s*(-?[\d.]+)/);
  if (lt) return { kind: "max", max: Number(lt[1]) };
  const gt = s.match(/^>\s*(-?[\d.]+)/);
  if (gt) return { kind: "min", min: Number(gt[1]) };
  const upTo = s.match(/up\s*to\s*(-?[\d.]+)/i);
  if (upTo) return { kind: "max", max: Number(upTo[1]) };
  const span = s.match(/^(-?[\d.]+)\s*[-–—]\s*(-?[\d.]+)/);
  if (span) {
    const low = Number(span[1]);
    const high = Number(span[2]);
    if (Number.isFinite(low) && Number.isFinite(high) && low <= high) {
      return { kind: "range", low, high };
    }
  }
  return null;
}

/** Parse a numeric value. Qualitative results (Negative, Positive, …)
 *  are not numbers → null. */
export function parseValue(input: string | number | null | undefined): number | null {
  if (input === null || input === undefined) return null;
  const s = normalizeDigits(input)!.replace(/,/g, "").replace(/\s+/g, "").trim();
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
  const v = Number(s);
  return Number.isFinite(v) ? v : null;
}

/** Deterministic status, in code. The model's status is never trusted. */
export function validateStatus(
  value: string | number | null | undefined,
  range: string | null,
): Status {
  const v = parseValue(value);
  const r = parseRange(range);
  if (v === null || r === null) return "unknown";
  if (r.kind === "range") {
    if (v < r.low) return "low";
    if (v > r.high) return "high";
    return "normal";
  }
  if (r.kind === "max") return v <= r.max ? "normal" : "high";
  return v >= r.min ? "normal" : "low";
}

/** Grounding: a value/range must appear in the extracted source text
 *  (after digit normalization). For images there is no source text,
 *  so the check is skipped — the status is still validated in code. */
function isGrounded(field: string | null, source: string): boolean {
  if (!field || !source.trim()) return true;
  const src = normalizeDigits(source)!.replace(/\s+/g, " ");
  const numbers = normalizeDigits(field)!.match(/-?\d+(\.\d+)?/g);
  if (!numbers) return false;
  return numbers.every((n) => src.includes(normalizeDigits(n)!.trim()));
}

/** Display form of a range, preserving the sheet's own formatting
 *  ("12.0-16.0" → "12.0 تا 16.0"). Numbers are never re-printed
 *  from parsed floats, which would drop trailing ".0". */
export function displayRange(range: string): string | null {
  let s = normalizeDigits(range)!.replace(/\s+/g, " ").trim();
  if (s.startsWith("(")) s = s.replace(/^\(\s*/, "").replace(/\)\s*$/, "");
  s = s.replace(/\s*\(.*$/, "");
  const span = s.match(/^(-?[\d.]+)\s*[-–—]\s*(-?[\d.]+)/);
  if (span) return `${span[1]} تا ${span[2]}`;
  return s;
}

/** Format a numeric gap without trailing ".0" ("0.9" stays "0.9"). */
function fmtGap(n: number): string {
  return String(Math.round(n * 1000) / 1000);
}

/** Explanation built from a template using the VALIDATED status only.
 *  The model's free sentence is never reused — that was the old bug:
 *  the badge said "high" while the sentence said "in range".
 *  Out-of-range sentences quantify the gap (value − bound, with unit). */
export function buildExplanation(
  value: string | null,
  range: string | null,
  status: Status,
  info: string,
  unit?: string | null,
): string {
  if (value === null) return `${info} مقدار آن خوانا نیست.`;
  const v = parseValue(value);
  const r = parseRange(range);
  if (v === null) return `${info} مقدار آن خوانا نیست.`;
  if (r === null || range === null) {
    return `${info} مقدار ${value} ثبت شده است، اما بازه روی برگه نیست، پس نمی‌توان گفت داخل بازه است یا نه؛ برای تفسیر به پزشک مراجعه کن.`;
  }
  const u = unit ? ` ${unit}` : "";
  if (r.kind === "range") {
    const span = displayRange(range) ?? `${r.low} تا ${r.high}`;
    if (status === "low") {
      return `${info} مقدار ${value} پایین‌تر از بازه ${span} روی برگه است؛ فقط ${fmtGap(r.low - v)}${u} کمتر از حد پایین بازه است.`;
    }
    if (status === "high") {
      return `${info} مقدار ${value} بالاتر از بازه ${span} روی برگه است؛ ${fmtGap(v - r.high)}${u} بالاتر از حد بالای بازه است.`;
    }
    return `${info} مقدار ${value} در بازه ${span} روی برگه است.`;
  }
  if (r.kind === "max") {
    if (status === "high") {
      return `${info} مقدار ${value} بیشتر از ${r.max} روی برگه است؛ ${fmtGap(v - r.max)}${u} بالاتر از حداکثر بازه است.`;
    }
    return `${info} مقدار ${value} کمتر از ${r.max} روی برگه است.`;
  }
  if (status === "low") {
    return `${info} مقدار ${value} کمتر از ${r.min} روی برگه است؛ ${fmtGap(r.min - v)}${u} پایین‌تر از حداقل بازه است.`;
  }
  return `${info} مقدار ${value} بیشتر از ${r.min} روی برگه است.`;
}

function safeText(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const s = String(value).trim();
  if (!s || s === "null" || s === "undefined") return null;
  return s.slice(0, maxLength);
}

/** Words that must never appear in a model-supplied definition. */
const BLOCKED_DEFINITION = ["تشخیص", "درمان", "دارو", "بیماری"];

function cleanDefinition(raw: unknown): string | null {
  const s = safeText(raw, 200);
  if (!s) return null;
  if (BLOCKED_DEFINITION.some((w) => s.includes(w))) return null;
  return fixSpelling(s);
}

/** Strip patient identifiers from the summary. */
export function sanitizeSummary(summary: string | null): string {
  if (!summary) return "";
  return fixSpelling(summary)
    .replace(/(?:آقای|خانم|آقا|خانوم|جناب|سرکار)\s+[\u0600-\u06FF]+(?:\s+[\u0600-\u06FF]+)?/g, "")
    .replace(/(?:کد ملی|شماره پرونده|شناسه|کد پذیرش|شماره بیمه)[:\s]*[\d۰-۹\-]+/g, "")
    .replace(/(?:تاریخ تولد|متولد)[:\s]*[\d۰-۹/\\-]+/g, "")
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([،.])/g, "$1")
    .trim();
}

const SECTIONS = new Set([
  "hematology", "biochemistry", "liver", "kidney", "lipids", "diabetes",
  "thyroid", "hormones", "immunology", "urine",
]);

/** Turn raw model output into validated tests. Unknown tests also
 *  produce a limitation line, so nothing is silently dropped. */
export function processTests(
  rawTests: unknown,
  sourceText: string,
): { tests: Test[]; limitations: string[] } {
  const list = Array.isArray(rawTests) ? rawTests.slice(0, MAX_TESTS) : [];
  const tests: Test[] = [];
  const limitations: string[] = [];

  for (const raw of list as RawTest[]) {
    const abbr = safeText(raw?.abbr, 40);
    const entry = canonical(abbr, safeText(raw?.name, 150));
    const name = entry ? entry[0] : fixSpelling(safeText(raw?.name, 150) ?? "نامشخص");
    // Dictionary first, model definition second, generic last resort.
    const info = entry
      ? entry[1]
      : (cleanDefinition(raw?.definition) ?? "این آزمایش یکی از موارد برگه آزمایش است.");

    let value = normalizeDigits(safeText(raw?.value, 80));
    let range = normalizeDigits(safeText(raw?.reference_range, 100));
    if (value !== null && !isGrounded(value, sourceText)) value = null;
    if (range !== null && !isGrounded(range, sourceText)) range = null;

    const section: Section = SECTIONS.has(raw?.section ?? "")
      ? raw.section as Section
      : "other";
    const status = validateStatus(value, range);
    const unit = safeText(raw?.unit, 50);
    const explanation = buildExplanation(value, range, status, info, unit);
    tests.push({
      name,
      abbr: abbr ? normalizeDigits(abbr) : null,
      value,
      unit,
      reference_range: range,
      status,
      section,
      explanation,
    });

    if (status === "unknown") {
      limitations.push(
        value === null
          ? `${name}: مقدار خوانا نیست.`
          : `${name}: بازه روی برگه نیست.`,
      );
    }
  }
  return { tests, limitations };
}

/** Range coverage: how many valued tests have a range. Drives pass selection. */
export function rangesCoverage(tests: Test[]): { valued: number; ranged: number; ratio: number } {
  const valued = tests.filter((t) => t.value !== null).length;
  const ranged = tests.filter((t) => t.value !== null && t.reference_range !== null).length;
  return { valued, ranged, ratio: valued === 0 ? 1 : ranged / valued };
}

/** Retry the AI call when ranges are systematically missing: fewer
 *  than half of the valued tests have a range (range-less rows are few). */
export function needsRangesRetry(tests: Test[]): boolean {
  const { valued, ratio } = rangesCoverage(tests);
  return valued > 0 && ratio < 0.5;
}

/** Merge fallback passes that refill missing ranges/units, matched by
 *  canonical or raw name. Values are never overwritten, and a range
 *  already present is never replaced. Sources are tried in order. */
export function mergeRanges(original: RawTest[], ...sources: RawTest[][]): RawTest[] {
  const byName = new Map<string, RawTest>();
  for (const src of sources) {
    for (const r of src) {
      const entry = canonical(r.abbr ?? null, r.name ?? null);
      if (entry) byName.set(entry[0], r);
      if (r.name) byName.set(r.name, r);
    }
  }
  return original.map((t) => {
    const entry = canonical(t.abbr ?? null, t.name ?? null);
    const hit = (entry ? byName.get(entry[0]) : undefined) ?? (t.name ? byName.get(t.name) : undefined);
    if (!hit) return t;
    const out = { ...t };
    if (!out.reference_range && hit.reference_range) out.reference_range = hit.reference_range;
    if (!out.unit && hit.unit) out.unit = hit.unit;
    return out;
  });
}

/** Parse the range-column-only pass ("W.B.C. — 4.5-11.5" lines).
 *  Name + range only; values are never taken from this pass. */
export function parseRangeColumn(text: string): RawTest[] {
  const out: RawTest[] = [];
  for (const line of text.split("\n")) {
    const m = line.match(/^(.+?)\s*[—–-]\s*(.+)$/);
    if (!m) continue;
    const name = m[1].trim();
    if (/^(test|نام)$/i.test(name)) continue;
    const range = m[2].trim().replace(/[()]/g, "").trim();
    if (!name || !range) continue;
    if (/^(no range|بدون بازه|null)$/i.test(range)) continue;
    out.push({ name, reference_range: range });
  }
  return out;
}

/** Count rows and rows-with-range in a verbatim "|"-separated
 *  transcription (pass 4). Header lines are skipped. */
export function countTranscription(text: string): { rows: number; ranged: number } {
  let rows = 0;
  let ranged = 0;
  for (const line of text.split("\n")) {
    const parts = line.split("|").map((p) => p.trim());
    if (parts.length < 4 || !parts[0]) continue;
    if (/^(test|نام)$/i.test(parts[0])) continue;
    rows++;
    const r = parts[3].replace(/[()]/g, "").trim().toLowerCase();
    if (r && r !== "no range" && r !== "بدون بازه" && r !== "null" && r !== "-") ranged++;
  }
  return { rows, ranged };
}

/** Keep a model limitation only if it does not contradict a test
 *  that was extracted with a known status. */
export function filterLimitations(limitations: string[], tests: Test[]): string[] {
  const known = new Set(
    tests.filter((t) => t.status !== "unknown").map((t) => t.name),
  );
  const negative = ["نامشخص", "ناخوانا", "خوانده نشد", "استخراج نشد", "پیدا نشد"];
  return limitations.filter((lim) => {
    if (!negative.some((w) => lim.includes(w))) return true;
    return ![...known].some((name) => lim.includes(name));
  });
}

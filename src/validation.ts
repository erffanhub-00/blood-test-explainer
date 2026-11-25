import type { RawTest, Status, Test } from "./types.js";
import { MAX_TESTS } from "./types.js";
import { canonical, fixSpelling } from "./names.js";

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

/** Explanation built from a template using the VALIDATED status only.
 *  The model's free sentence is never reused — that was the old bug:
 *  the badge said "high" while the sentence said "in range". */
export function buildExplanation(
  value: string | null,
  range: string | null,
  status: Status,
  info: string,
): string {
  if (value === null) return `${info} مقدار آن خوانا نیست.`;
  const v = parseValue(value);
  const r = parseRange(range);
  if (v === null) return `${info} مقدار آن خوانا نیست.`;
  if (r === null || range === null) {
    return `${info} مقدار ${value} ثبت شده است، اما بازه روی برگه نیست، برای تفسیر به پزشک مراجعه کن.`;
  }
  if (r.kind === "range") {
    const span = displayRange(range) ?? `${r.low} تا ${r.high}`;
    if (status === "low") return `${info} مقدار ${value} پایین‌تر از بازه ${span} روی برگه است.`;
    if (status === "high") return `${info} مقدار ${value} بالاتر از بازه ${span} روی برگه است.`;
    return `${info} مقدار ${value} در بازه ${span} روی برگه است.`;
  }
  if (r.kind === "max") {
    const verb = status === "high" ? "بیشتر از" : "کمتر از";
    return `${info} مقدار ${value} ${verb} ${r.max} روی برگه است.`;
  }
  const verb = status === "low" ? "کمتر از" : "بیشتر از";
  return `${info} مقدار ${value} ${verb} ${r.min} روی برگه است.`;
}

function safeText(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const s = String(value).trim();
  if (!s || s === "null" || s === "undefined") return null;
  return s.slice(0, maxLength);
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
    const info = entry
      ? entry[1]
      : "این آزمایش یکی از موارد برگه آزمایش است.";

    let value = normalizeDigits(safeText(raw?.value, 80));
    let range = normalizeDigits(safeText(raw?.reference_range, 100));
    if (value !== null && !isGrounded(value, sourceText)) value = null;
    if (range !== null && !isGrounded(range, sourceText)) range = null;

    const status = validateStatus(value, range);
    const explanation = buildExplanation(value, range, status, info);
    tests.push({
      name,
      abbr: abbr ? normalizeDigits(abbr) : null,
      value,
      unit: safeText(raw?.unit, 50),
      reference_range: range,
      status,
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

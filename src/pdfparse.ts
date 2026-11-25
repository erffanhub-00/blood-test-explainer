// Deterministic PDF path: extract embedded text with unpdf (code, no AI)
// and parse the lab table with regex. Text PDFs cost zero AI calls;
// scanned/image PDFs have no text layer and still go to AI.

import { extractText, getDocumentProxy } from "unpdf";
import type { RawTest, Section } from "./types.js";
import { normalizeDigits, parseValue } from "./validation.js";

/** Extract the text layer of a PDF in code. Throws on scanned PDFs,
 *  corrupt files, or a 20s timeout — the caller falls back to AI. */
export async function extractPdfText(bytes: Uint8Array): Promise<string> {
  const proxy = await getDocumentProxy(bytes);
  const text = await Promise.race([
    extractText(proxy, { mergePages: true }).then((r) => r.text),
    new Promise<string>((_resolve, reject) =>
      setTimeout(() => reject(new Error("pdf-timeout")), 20000),
    ),
  ]);
  return text;
}

const SECTION_HEADERS: Record<string, Section> = {
  hematology: "hematology",
  haematology: "hematology",
  biochemistry: "biochemistry",
  liver: "liver",
  kidney: "kidney",
  renal: "kidney",
  lipids: "lipids",
  lipid: "lipids",
  diabetes: "diabetes",
  thyroid: "thyroid",
  hormones: "hormones",
  hormone: "hormones",
  immunology: "immunology",
  urine: "urine",
  urinalysis: "urine",
};

const FA_SECTION_HEADERS: Record<string, Section> = {
  هماتولوژی: "hematology", بیوشیمی: "biochemistry", کبد: "liver", کلیه: "kidney",
  چربیخون: "lipids", تیروئید: "thyroid", هورمون: "hormones", ایمنی: "immunology",
  ادرار: "urine", دیابت: "diabetes",
};

// Lines that are never test rows (headers, patient info, footers).
// Exact names only — "Testosterone" must NOT match "test".
const SKIP_NAMES = new Set([
  "test", "result", "unit", "reference", "range", "flag", "patient", "name",
  "date", "age", "sex", "lab", "laboratory", "report", "page", "no",
  "نام", "نتیجه", "واحد", "بازه", "محدوده", "ردیف",
]);

/** Find a reference range in the text after the value; also returns the unit text before it. */
function splitRange(rest: string): { range: string | null; unit: string | null } {
  const upTo = rest.match(/up\s*to\s*(-?[\d.]+)/i);
  if (upTo) {
    return { range: `Up to ${upTo[1]}`, unit: rest.slice(0, upTo.index).trim() || null };
  }
  const lt = rest.match(/<\s*(-?[\d.]+)/);
  if (lt) {
    return { range: `<${lt[1]}`, unit: rest.slice(0, lt.index).trim() || null };
  }
  const gt = rest.match(/>\s*(-?[\d.]+)/);
  if (gt) {
    return { range: `>${gt[1]}`, unit: rest.slice(0, gt.index).trim() || null };
  }
  const span = rest.match(/(-?[\d.]+)\s*[-–—]\s*(-?[\d.]+)/);
  if (span) {
    return { range: `${span[1]}-${span[2]}`, unit: rest.slice(0, span.index).trim() || null };
  }
  return { range: null, unit: rest.trim() || null };
}

/** Parse extracted PDF text into raw tests (one row per line; the Flag column is ignored). */
export function parsePdfTable(text: string): RawTest[] {
  const out: RawTest[] = [];
  let section: Section = "other";
  for (const rawLine of normalizeDigits(text)!.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    const header = line.replace(/[:\s]+$/, "").toLowerCase();
    const faHeader = line.replace(/[:\s]+$/, "").replace(/\s+/g, "");
    if (SECTION_HEADERS[header]) { section = SECTION_HEADERS[header]; continue; }
    if (FA_SECTION_HEADERS[faHeader]) { section = FA_SECTION_HEADERS[faHeader]; continue; }
    const m = line.match(/^(.+?)\s+(-?[\d.,]+)\s*(.*)$/);
    if (!m) continue;
    const name = m[1].trim();
    if (name.length < 2 || SKIP_NAMES.has(name.toLowerCase().replace(/[:.]$/, ""))) continue;
    const valueStr = m[2].replace(/,/g, "");
    if (parseValue(valueStr) === null) continue;
    const { range, unit } = splitRange(m[3]);
    const cleanUnit = unit ? unit.split(/\s+/)[0].slice(0, 50) : null;
    out.push({ name, value: valueStr, unit: cleanUnit, reference_range: range, section });
  }
  return out;
}

/** Use the deterministic parse directly (zero AI calls) when it found
 *  >= 5 valued tests and >= half of them have a range. */
export function shouldUseDeterministicParse(tests: RawTest[]): boolean {
  const valued = tests.filter((t) => t.value !== null && t.value !== undefined);
  if (valued.length < 5) return false;
  const ranged = valued.filter((t) => t.reference_range).length;
  return ranged / valued.length >= 0.5;
}

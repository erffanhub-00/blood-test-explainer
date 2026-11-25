import type { Ai } from "@cloudflare/workers-types";

export const MODEL = "@cf/meta/llama-4-scout-17b-16e-instruct";

/** Alternate vision models, tried in order when the main model keeps
 *  dropping the range column. VERIFIED against the official Workers AI
 *  catalog 2026-11-25: "@cf/qwen/qwen2.5-vl-32b-instruct" and
 *  "@cf/meta/llama-3.2-90b-vision-instruct" are NOT in the catalog,
 *  so they are not listed here. Each model gets at most one attempt. */
export const MODEL_FALLBACKS = [
  "@cf/meta/llama-3.2-11b-vision-instruct",
  "@cf/mistralai/mistral-small-3.1-24b-instruct",
] as const;
export const MAX_FILE_SIZE = 10 * 1024 * 1024;
export const MAX_TESTS = 100;
export const DISCLAIMER =
  "این توضیحات صرفاً برای آگاهی عمومی هستند و جایگزین نظر پزشک نیستند.";

export const ALLOWED_MIMES = new Set([
  "application/pdf", "image/jpeg", "image/jpg", "image/png", "image/webp",
]);
export const ALLOWED_EXTENSIONS = [".pdf", ".jpg", ".jpeg", ".png", ".webp"];

export interface Env {
  AI: Ai;
  ASSETS: Fetcher;
}

export type Status = "normal" | "low" | "high" | "unknown";

export type Section =
  | "hematology"
  | "biochemistry"
  | "liver"
  | "kidney"
  | "lipids"
  | "diabetes"
  | "thyroid"
  | "hormones"
  | "immunology"
  | "urine"
  | "other";

/** One test exactly as the model returns it. No status, no explanation:
 *  both are computed in code from the validated numbers. `definition`
 *  is a one-sentence "what this test measures" the model may supply
 *  for tests missing from the dictionary — never a verdict. */
export interface RawTest {
  name?: string | null;
  abbr?: string | null;
  value?: string | number | null;
  unit?: string | null;
  reference_range?: string | null;
  section?: string | null;
  definition?: string | null;
}

export interface Test {
  name: string;
  abbr: string | null;
  value: string | null;
  unit: string | null;
  reference_range: string | null;
  status: Status;
  section: Section;
  explanation: string;
}

export interface AnalysisResult {
  summary: string;
  tests: Test[];
  limitations: string[];
  disclaimer: string;
  requestId: string;
}

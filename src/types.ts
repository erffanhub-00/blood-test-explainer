import type { Ai } from "@cloudflare/workers-types";

export const MODEL = "@cf/meta/llama-4-scout-17b-16e-instruct";
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

/** One test exactly as the model returns it. No status, no explanation:
 *  both are computed in code from the validated numbers. */
export interface RawTest {
  name?: string | null;
  abbr?: string | null;
  value?: string | number | null;
  unit?: string | null;
  reference_range?: string | null;
}

export interface Test {
  name: string;
  abbr: string | null;
  value: string | null;
  unit: string | null;
  reference_range: string | null;
  status: Status;
  explanation: string;
}

export interface AnalysisResult {
  summary: string;
  tests: Test[];
  limitations: string[];
  disclaimer: string;
  requestId: string;
}

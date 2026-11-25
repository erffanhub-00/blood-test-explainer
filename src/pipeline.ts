// Staged-processing manager: the orchestration logic for extraction.
// Stages are data, not scattered if-chains. The manager scores the
// merged result after every round and decides the next round —
// fastest path to the most correct answer, inside a fixed budget.
//
// Round templates (value-per-cost order):
//   R1 full + range-column-only (concurrent)
//   R2 section passes (only lacking sections) + ranges-only retry
//   R3 alternate model + transcription (concurrent)
//   R4 Jimp enhanced image + second alternate model
// Each round is pruned by preconditions and by the remaining budget;
// a stage that cannot improve the current gap never runs.

import type { Section, Test } from "./types.js";
import { DIFFERENTIAL_NAMES } from "./names.js";

/** Hard cap on Workers AI calls per request. */
export const CALL_BUDGET = 8;
/** Global time budget per request (ms). */
export const TIME_BUDGET_MS = 120_000;
/** Per-call timeout (ms). A timed-out call is skipped, never fatal. */
export const CALL_TIMEOUT_MS = 50_000;
/** Stop escalating when less than this much time remains. */
export const MIN_REMAINING_MS = 25_000;

export type StageId =
  | "full"
  | "range_column"
  | "ranges_only"
  | "section_hematology"
  | "section_biochemistry"
  | "transcription"
  | "alt_model_1"
  | "alt_model_2"
  | "enhanced_image";

export interface PipelineCtx {
  score: Score;
  stagesRun: StageId[];
  callsUsed: number;
  callsBudget: number;
  elapsedMs: number;
  timeBudgetMs: number;
  hasImage: boolean;
  isWebp: boolean;
  lackingSections: Section[];
  valueGapSections: Section[];
}

export interface StageDef {
  id: StageId;
  /** AI calls this stage costs (transcription = transcribe + structure). */
  calls: number;
  /** What this stage can improve. */
  gain: "values+ranges" | "ranges";
  runWhen: (ctx: PipelineCtx) => boolean;
}

const rangesGap = (ctx: PipelineCtx): boolean => ctx.score.ranges < 0.9;
const notGood = (ctx: PipelineCtx): boolean => !ctx.score.goodEnough;

export const STAGES: Record<StageId, StageDef> = {
  full: {
    id: "full",
    calls: 1,
    gain: "values+ranges",
    runWhen: (ctx) => ctx.stagesRun.length === 0,
  },
  range_column: {
    id: "range_column",
    calls: 1,
    gain: "ranges",
    // Cheap and narrow: only the Reference Interval column.
    runWhen: (ctx) => ctx.hasImage && rangesGap(ctx),
  },
  ranges_only: {
    id: "ranges_only",
    calls: 1,
    gain: "ranges",
    // Deterministic re-read (temperature 0): the ranges-only retry.
    runWhen: (ctx) => rangesGap(ctx),
  },
  section_hematology: {
    id: "section_hematology",
    calls: 1,
    gain: "values+ranges",
    runWhen: (ctx) =>
      ctx.lackingSections.includes("hematology") ||
      ctx.valueGapSections.includes("hematology"),
  },
  section_biochemistry: {
    id: "section_biochemistry",
    calls: 1,
    gain: "values+ranges",
    runWhen: (ctx) =>
      ctx.lackingSections.includes("biochemistry") ||
      ctx.valueGapSections.includes("biochemistry"),
  },
  transcription: {
    id: "transcription",
    calls: 2,
    gain: "values+ranges",
    // Only after the cheap image passes failed to reach goodEnough.
    runWhen: (ctx) => ctx.hasImage && notGood(ctx),
  },
  alt_model_1: {
    id: "alt_model_1",
    calls: 1,
    gain: "values+ranges",
    // Only when the main-model passes failed.
    runWhen: (ctx) => notGood(ctx),
  },
  alt_model_2: {
    id: "alt_model_2",
    calls: 1,
    gain: "values+ranges",
    runWhen: (ctx) => notGood(ctx) && ctx.stagesRun.includes("alt_model_1"),
  },
  enhanced_image: {
    id: "enhanced_image",
    calls: 1,
    gain: "values+ranges",
    // Last resort, JPEG/PNG only — Jimp has no WEBP decoder.
    runWhen: (ctx) => ctx.hasImage && !ctx.isWebp && notGood(ctx),
  },
};

/** Round templates in value-per-cost order. decideNext walks them in
 *  order and returns the first round that still has a runnable stage,
 *  pruned by preconditions and by the remaining call budget. */
const ROUND_TEMPLATES: StageId[][] = [
  ["full", "range_column"],
  ["section_hematology", "section_biochemistry", "ranges_only"],
  ["alt_model_1", "transcription"],
  ["enhanced_image", "alt_model_2"],
];

export interface Score {
  /** Fraction of rows with a value. */
  values: number;
  /** Fraction of valued tests that SHOULD have a range and do.
   *  Differential rows genuinely have no range and are excluded. */
  ranges: number;
  /** Fraction of valued tests with a unit. */
  units: number;
  goodEnough: boolean;
}

export function scoreTests(tests: Test[]): Score {
  const total = tests.length;
  if (total === 0) return { values: 0, ranges: 0, units: 0, goodEnough: false };
  const valued = tests.filter((t) => t.value !== null);
  const values = valued.length / total;
  const shouldRange = valued.filter((t) => !DIFFERENTIAL_NAMES.has(t.name));
  const ranged = shouldRange.filter((t) => t.reference_range !== null).length;
  const ranges = shouldRange.length === 0 ? 1 : ranged / shouldRange.length;
  const units =
    valued.length === 0
      ? 0
      : valued.filter((t) => t.unit !== null && t.unit !== "").length / valued.length;
  return { values, ranges, units, goodEnough: values >= 0.95 && ranges >= 0.9 };
}

export interface Gaps {
  /** Sections with valued tests that still lack a range. */
  lackingSections: Section[];
  /** Sections with rows that still lack a value. */
  valueGapSections: Section[];
}

export function analyzeGaps(tests: Test[]): Gaps {
  const lacking = new Set<Section>();
  const valueGap = new Set<Section>();
  for (const t of tests) {
    if (t.value === null) {
      valueGap.add(t.section);
    } else if (t.reference_range === null && !DIFFERENTIAL_NAMES.has(t.name)) {
      lacking.add(t.section);
    }
  }
  return { lackingSections: [...lacking], valueGapSections: [...valueGap] };
}

export type StopReason = "good_enough" | "budget" | "all_strategies_tried";

export type Decision =
  | { action: "stop"; stages: []; reason: StopReason }
  | { action: "run"; stages: StageId[]; reason: "escalate" };

/** Pure decision function: given the current state, what next?
 *  Every rule is explicit and unit-testable. */
export function decideNext(ctx: PipelineCtx): Decision {
  if (ctx.score.goodEnough) {
    return { action: "stop", stages: [], reason: "good_enough" };
  }
  if (ctx.callsUsed >= ctx.callsBudget) {
    return { action: "stop", stages: [], reason: "budget" };
  }
  if (ctx.timeBudgetMs - ctx.elapsedMs < MIN_REMAINING_MS) {
    return { action: "stop", stages: [], reason: "budget" };
  }
  const callsLeft = ctx.callsBudget - ctx.callsUsed;
  for (const template of ROUND_TEMPLATES) {
    const stages: StageId[] = [];
    let cost = 0;
    for (const id of template) {
      if (ctx.stagesRun.includes(id)) continue;
      const def = STAGES[id];
      if (!def.runWhen(ctx)) continue;
      // A stage that does not fit the remaining call budget is skipped;
      // a cheaper later stage in the same round may still run.
      // Transcription needs both of its calls — never half-run it.
      if (cost + def.calls > callsLeft) continue;
      stages.push(id);
      cost += def.calls;
    }
    if (stages.length > 0) return { action: "run", stages, reason: "escalate" };
  }
  return { action: "stop", stages: [], reason: "all_strategies_tried" };
}

/** SSE stage name for a round: the round's main work. */
export function roundStageName(stages: StageId[]): string {
  if (stages.includes("full")) return "reading_table";
  if (stages.includes("section_hematology") || stages.includes("section_biochemistry")) {
    return "reading_sections";
  }
  if (stages.includes("transcription")) return "transcribing";
  if (stages.includes("alt_model_1") || stages.includes("alt_model_2")) {
    return "trying_other_model";
  }
  if (stages.includes("enhanced_image")) return "enhancing_image";
  return "reading_ranges";
}

/** Progress percent for a round number: R1 25%, R2 50%, R3 75%, R4 90%. */
export function roundProgress(roundNo: number): number {
  return Math.min(90, 25 * roundNo);
}

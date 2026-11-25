import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CALL_BUDGET,
  TIME_BUDGET_MS,
  analyzeGaps,
  decideNext,
  roundProgress,
  roundStageName,
  scoreTests,
  type PipelineCtx,
  type StageId,
} from "../src/pipeline.js";
import type { Section, Test } from "../src/types.js";

function t(
  name: string,
  value: string | null,
  range: string | null,
  section: Section = "hematology",
): Test {
  return {
    name,
    abbr: null,
    value,
    unit: "%",
    reference_range: range,
    status: "unknown",
    section,
    explanation: "",
  };
}

// The real 20-test sheet: 13 hematology (9 ranged + 4 differential with
// genuinely no range) + 7 biochemistry, all ranged.
const REAL_SHEET: Test[] = [
  ...["W.B.C.", "R.B.C.", "Hb", "H.C.T", "M.C.V", "M.C.H", "MCHC", "PLT", "RDW"].map(
    (n, i) =>
      t(n, "1", ["4.5-11.5", "4.21-5.91", "13.8-17.5", "41.5-50.4", "79.1-94.9", "27.5-33.2", "32.1-36.1", "150-450", "10-15.6"][i]),
  ),
  t("نوتروفیل", "46", null),
  t("لنفوسیت", "50", null),
  t("مونوسیت", "3", null),
  t("ائوزینوفیل", "1", null),
  ...["B.U.N", "Creatinine", "A.S.T.", "A.L.T.", "ALP", "Bilirubin Total", "Bilirubin Direct"].map(
    (n, i) =>
      t(n, "1", ["5-23", "0.7-1.4", "Up to 40", "Up to 40", "80-468", "0.2-1.2", "<0.5"][i], "biochemistry"),
  ),
];

const DROPPED_SHEET: Test[] = REAL_SHEET.map((x) => ({ ...x, reference_range: null }));

// Same sheet, but only the hematology section lost its ranges.
const HEMA_BROKEN: Test[] = REAL_SHEET.map((x) =>
  x.section === "hematology" && !["نوتروفیل", "لنفوسیت", "مونوسیت", "ائوزینوفیل"].includes(x.name)
    ? { ...x, reference_range: null }
    : x,
);

const ALL_STAGES: StageId[] = [
  "full", "range_column", "ranges_only", "section_hematology", "section_biochemistry",
  "transcription", "alt_model_1", "alt_model_2", "enhanced_image",
];

function baseCtx(overrides: Partial<PipelineCtx> = {}): PipelineCtx {
  return {
    score: { values: 1, ranges: 1, units: 1, goodEnough: true },
    stagesRun: [],
    callsUsed: 0,
    callsBudget: CALL_BUDGET,
    elapsedMs: 0,
    timeBudgetMs: TIME_BUDGET_MS,
    hasImage: true,
    isWebp: false,
    lackingSections: [],
    valueGapSections: [],
    ...overrides,
  };
}

function ctxFor(tests: Test[], overrides: Partial<PipelineCtx> = {}): PipelineCtx {
  const gaps = analyzeGaps(tests);
  return baseCtx({
    score: scoreTests(tests),
    lackingSections: gaps.lackingSections,
    valueGapSections: gaps.valueGapSections,
    ...overrides,
  });
}

test("score: the real sheet is goodEnough — the 4 differential rows do not count against ranges", () => {
  const s = scoreTests(REAL_SHEET);
  assert.equal(s.values, 1);
  assert.equal(s.ranges, 1);
  assert.equal(s.goodEnough, true);
});

test("score: his run (0/20 ranges) is not goodEnough", () => {
  const s = scoreTests(DROPPED_SHEET);
  assert.equal(s.values, 1);
  assert.equal(s.ranges, 0);
  assert.equal(s.goodEnough, false);
});

test("score: missing values fail the values bar even when ranges are fine", () => {
  const s = scoreTests([t("Hb", null, "13.8-17.5"), t("W.B.C.", "4.5", "4.5-11.5")]);
  assert.equal(s.values, 0.5);
  assert.equal(s.goodEnough, false);
});

test("decision (a): perfect first round → stop, 2 calls used", () => {
  const d = decideNext(ctxFor(REAL_SHEET, { stagesRun: ["full", "range_column"], callsUsed: 2 }));
  assert.equal(d.action, "stop");
  assert.equal(d.reason, "good_enough");
  assert.deepEqual(d.stages, []);
});

test("decision (b): ranges missing, values fine → next is range-column-only, NOT transcription", () => {
  const d = decideNext(ctxFor(DROPPED_SHEET, { stagesRun: ["full"], callsUsed: 1 }));
  assert.equal(d.action, "run");
  assert.deepEqual(d.stages, ["range_column"]);
  assert.ok(!d.stages.includes("transcription"));
});

test("decision (c): one section broken → only that section's pass runs", () => {
  const d = decideNext(
    ctxFor(HEMA_BROKEN, { stagesRun: ["full", "range_column", "ranges_only"], callsUsed: 3 }),
  );
  assert.equal(d.action, "run");
  assert.deepEqual(d.stages, ["section_hematology"]);
});

test("decision (d): WEBP → the Jimp stage is skipped", () => {
  const d = decideNext(
    ctxFor(DROPPED_SHEET, {
      isWebp: true,
      stagesRun: ["full", "range_column", "section_hematology", "section_biochemistry", "ranges_only", "alt_model_1", "transcription"],
      callsUsed: 7,
    }),
  );
  assert.equal(d.action, "run");
  assert.ok(!d.stages.includes("enhanced_image"), "Jimp must never run on WEBP");
  assert.deepEqual(d.stages, ["alt_model_2"]);
});

test("decision (e): budget nearly spent → stop with the best result so far", () => {
  const timeOut = decideNext(ctxFor(DROPPED_SHEET, { stagesRun: ["full"], callsUsed: 1, elapsedMs: 100_000 }));
  assert.equal(timeOut.action, "stop");
  assert.equal(timeOut.reason, "budget");
  const callsOut = decideNext(ctxFor(DROPPED_SHEET, { stagesRun: ["full"], callsUsed: 8 }));
  assert.equal(callsOut.action, "stop");
  assert.equal(callsOut.reason, "budget");
});

test("decision (f): all stages tried, still not goodEnough → stop, never loop forever", () => {
  const d = decideNext(ctxFor(DROPPED_SHEET, { stagesRun: ALL_STAGES, callsUsed: 8 }));
  assert.equal(d.action, "stop");
  assert.equal(d.reason, "budget");
  const d2 = decideNext(ctxFor(DROPPED_SHEET, { stagesRun: ALL_STAGES, callsUsed: 5 }));
  assert.equal(d2.action, "stop");
  assert.equal(d2.reason, "all_strategies_tried");
});

test("decision: a 2-call stage that does not fit the remaining budget is skipped, a cheaper one still runs", () => {
  const d = decideNext(
    ctxFor(DROPPED_SHEET, {
      stagesRun: ["full", "range_column", "section_hematology", "section_biochemistry", "ranges_only"],
      callsUsed: 7,
    }),
  );
  assert.equal(d.action, "run");
  // Round 3 is [alt_model_1, transcription]: transcription (2 calls) does
  // not fit in the 1 remaining call, alt_model_1 does.
  assert.deepEqual(d.stages, ["alt_model_1"]);
});

test("decision: values are the problem → range-only stages are skipped; the section pass re-reads the values", () => {
  const valueGap = [t("Hb", null, "13.8-17.5"), t("W.B.C.", null, "4.5-11.5")];
  const d = decideNext(ctxFor(valueGap, { stagesRun: ["full", "range_column"], callsUsed: 2 }));
  assert.equal(d.action, "run");
  assert.ok(!d.stages.includes("ranges_only"), "ranges-only cannot fix missing values");
  assert.ok(!d.stages.includes("range_column"), "range-column cannot fix missing values");
  // The hematology section pass re-extracts the section, values included.
  assert.deepEqual(d.stages, ["section_hematology"]);
});

test("round helpers: stage names and progress follow the round", () => {
  assert.equal(roundStageName(["full", "range_column"]), "reading_table");
  assert.equal(roundStageName(["section_hematology", "ranges_only"]), "reading_sections");
  assert.equal(roundStageName(["alt_model_1", "transcription"]), "transcribing");
  assert.equal(roundStageName(["alt_model_2"]), "trying_other_model");
  assert.equal(roundStageName(["enhanced_image"]), "enhancing_image");
  assert.equal(roundStageName(["ranges_only"]), "reading_ranges");
  assert.deepEqual([1, 2, 3, 4, 5].map(roundProgress), [25, 50, 75, 90, 90]);
});

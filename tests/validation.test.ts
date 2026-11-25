import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath, URL as NodeURL } from "node:url";
import {
  buildExplanation,
  displayRange,
  mergeRanges,
  needsRangesRetry,
  normalizeDigits,
  parseRange,
  parseValue,
  processTests,
  validateStatus,
} from "../src/validation.js";
import { buildPrompt } from "../src/prompt.js";

test("normalizeDigits converts Persian and Arabic digits", () => {
  assert.equal(normalizeDigits("۲۱۰"), "210");
  assert.equal(normalizeDigits("٢١٠"), "210");
  assert.equal(normalizeDigits("13.5"), "13.5");
  assert.equal(normalizeDigits(null), null);
});

test("parseRange handles all lab formats", () => {
  assert.deepEqual(parseRange("12-16"), { kind: "range", low: 12, high: 16 });
  assert.deepEqual(parseRange("12.0 - 16.0"), { kind: "range", low: 12, high: 16 });
  assert.deepEqual(parseRange("12–16"), { kind: "range", low: 12, high: 16 });
  assert.deepEqual(parseRange("<200"), { kind: "max", max: 200 });
  assert.deepEqual(parseRange(">70"), { kind: "min", min: 70 });
  assert.deepEqual(parseRange("up to 200"), { kind: "max", max: 200 });
  assert.deepEqual(parseRange("Up to 40 Child:20-60"), { kind: "max", max: 40 });
  assert.deepEqual(parseRange("<0.5"), { kind: "max", max: 0.5 });
  assert.deepEqual(parseRange("(12-16)"), { kind: "range", low: 12, high: 16 });
  assert.deepEqual(parseRange("12-16 mg/dL"), { kind: "range", low: 12, high: 16 });
  assert.equal(parseRange("N/A"), null);
  assert.equal(parseRange(null), null);
});

test("displayRange keeps the sheet's own number formatting", () => {
  assert.equal(displayRange("12.0-16.0"), "12.0 تا 16.0");
  assert.equal(displayRange("(12-16)"), "12 تا 16");
  assert.equal(displayRange("12–16"), "12 تا 16");
  assert.equal(displayRange("0-200"), "0 تا 200");
});

test("validateStatus is deterministic and never trusts the model", () => {
  assert.equal(validateStatus("6.2", "4.0-11.0"), "normal");
  assert.equal(validateStatus("210", "0-200"), "high");
  assert.equal(validateStatus("11", "12-16"), "low");
  assert.equal(validateStatus("۲۱۰", "0-200"), "high");
  assert.equal(validateStatus("150", "<200"), "normal");
  assert.equal(validateStatus("210", "<200"), "high");
  assert.equal(validateStatus("50", ">70"), "low");
  assert.equal(validateStatus("95", null), "unknown");
  assert.equal(validateStatus(null, "0-200"), "unknown");
  assert.equal(validateStatus("Negative", "Negative"), "unknown");
});

test("parseValue rejects qualitative results", () => {
  assert.equal(parseValue("Negative"), null);
  assert.equal(parseValue("Positive"), null);
  assert.equal(parseValue("13.5"), 13.5);
});

test("cholesterol fix: badge and sentence come from the same status", () => {
  const status = validateStatus("210", "0-200");
  assert.equal(status, "high");
  const explanation = buildExplanation(
    "210",
    "0-200",
    status,
    "کلسترول نوعی چربی خون است.",
    "mg/dL",
  );
  assert.equal(
    explanation,
    "کلسترول نوعی چربی خون است. مقدار 210 بالاتر از بازه 0 تا 200 روی برگه است؛ 10 mg/dL بالاتر از حد بالای بازه است.",
  );
  assert.ok(!explanation.includes("در محدوده است"));
});

test("low sentence quantifies the gap: HCT 40.6 vs 41.5-50.4", () => {
  const explanation = buildExplanation(
    "40.6",
    "41.5-50.4",
    "low",
    "هماتوکریت درصد حجم خون است که گلبول قرمز تشکیل می‌دهد.",
    "%",
  );
  assert.ok(explanation.includes("پایین‌تر از بازه 41.5 تا 50.4 روی برگه است"));
  assert.ok(explanation.includes("0.9 % کمتر از حد پایین بازه است"));
});

test("no range and unreadable value get honest explanations", () => {
  assert.equal(
    buildExplanation("85", null, "unknown", "فریتین ذخیره آهن بدن را نشان می‌دهد."),
    "فریتین ذخیره آهن بدن را نشان می‌دهد. مقدار 85 ثبت شده است، اما بازه روی برگه نیست، پس نمی‌توان گفت داخل بازه است یا نه؛ برای تفسیر به پزشک مراجعه کن.",
  );
  assert.equal(
    buildExplanation(null, "0-150", "unknown", "تری‌گلیسرید نوعی چربی خون است."),
    "تری‌گلیسرید نوعی چربی خون است. مقدار آن خوانا نیست.",
  );
});

test("differential tests with no range are unknown, never compared to a range", () => {
  const { tests } = processTests(
    [
      { name: "Neutrophil", abbr: null, value: "46", unit: "%", reference_range: null, section: "hematology" },
      { name: "Lymphocyte", abbr: null, value: "50", unit: "%", reference_range: null, section: "hematology" },
      { name: "Monocyte", abbr: null, value: "3", unit: "%", reference_range: null, section: "hematology" },
      { name: "Eosinophil", abbr: null, value: "1", unit: "%", reference_range: null, section: "hematology" },
    ],
    "",
  );
  assert.deepEqual(tests.map((t) => t.status), ["unknown", "unknown", "unknown", "unknown"]);
  assert.deepEqual(tests.map((t) => t.name), ["نوتروفیل", "لنفوسیت", "مونوسیت", "ائوزینوفیل"]);
  for (const t of tests) {
    assert.ok(t.explanation.includes("بازه روی برگه نیست"));
    assert.ok(!t.explanation.includes("در بازه"));
    assert.ok(!t.explanation.includes("بالاتر از بازه"));
    assert.ok(!t.explanation.includes("پایین‌تر از بازه"));
  }
});

// The sample used by the "برگه نمونه" button. Raw rows as the model
// would return them; the processed output must equal public/sample.json.
const RAW_SAMPLE = [
  { name: "WBC", abbr: "WBC", value: "6.2", unit: "10^3/uL", reference_range: "4.0-11.0", section: "hematology" },
  { name: "RBC", abbr: "RBC", value: "4.8", unit: "10^6/uL", reference_range: "4.2-5.8", section: "hematology" },
  { name: "Hb", abbr: "Hb", value: "13.5", unit: "g/dL", reference_range: "12.0-16.0", section: "hematology" },
  { name: "HCT", abbr: "HCT", value: "40.6", unit: "%", reference_range: "36.0-48.0", section: "hematology" },
  { name: "PLT", abbr: "PLT", value: "250", unit: "10^3/uL", reference_range: "150-400", section: "hematology" },
  { name: "Glucose", abbr: "Glucose", value: "95", unit: "mg/dL", reference_range: "70-99", section: "biochemistry" },
  { name: "Cholesterol", abbr: "Cholesterol", value: "210", unit: "mg/dL", reference_range: "0-200", section: "biochemistry" },
  { name: "Ferritin", abbr: "Ferritin", value: "85", unit: "ng/mL", reference_range: null, section: "biochemistry" },
  { name: "TG", abbr: "TG", value: null, unit: "mg/dL", reference_range: "0-150", section: "biochemistry" },
];

test("sample: 6 normal, 1 high, 2 unknown", () => {
  const { tests, limitations } = processTests(RAW_SAMPLE, "");
  assert.equal(tests.length, 9);
  assert.deepEqual(
    tests.map((t) => t.status),
    ["normal", "normal", "normal", "normal", "normal", "normal", "high", "unknown", "unknown"],
  );
  assert.equal(tests[6].name, "کلسترول کل");
  assert.ok(tests[6].explanation.includes("مقدار 210 بالاتر از بازه 0 تا 200 روی برگه است"));
  assert.deepEqual(limitations, ["فریتین: بازه روی برگه نیست.", "تری‌گلیسرید: مقدار خوانا نیست."]);
});

test("sample.json is exactly what processTests produces", () => {
  const sample = JSON.parse(
    readFileSync(fileURLToPath(new NodeURL("../../public/sample.json", import.meta.url)), "utf-8"),
  );
  const { tests } = processTests(RAW_SAMPLE, "");
  assert.deepEqual(sample.tests, tests);
  assert.equal(sample.tests.length, 9);
});

test("grounding: a value not in the source text is dropped", () => {
  const source = "WBC 6.2 4.0-11.0";
  const { tests } = processTests(
    [{ name: "WBC", abbr: "WBC", value: "9.9", unit: "10^3/uL", reference_range: "4.0-11.0" }],
    source,
  );
  assert.equal(tests[0].value, null);
  assert.equal(tests[0].status, "unknown");
  const { tests: ok } = processTests(
    [{ name: "WBC", abbr: "WBC", value: "6.2", unit: "10^3/uL", reference_range: "4.0-11.0" }],
    source,
  );
  assert.equal(ok[0].value, "6.2");
  assert.equal(ok[0].status, "normal");
});

// The real 20-test sheet from the live test (2026-11-25): dotted
// abbreviations, two sections, a differential with no ranges, and
// "Up to 40" / "<0.5" ranges. Live result: 15 normal, 1 low, 4 unknown.
const REAL_SHEET = [
  { name: "W.B.C.", abbr: "W.B.C.", value: "4.5", unit: "x1000/µL", reference_range: "4.5-11.5", section: "hematology" },
  { name: "R.B.C.", abbr: "R.B.C.", value: "4.32", unit: "x1000000/µL", reference_range: "4.21-5.91", section: "hematology" },
  { name: "Hb", abbr: "Hb", value: "13.9", unit: "g/dL", reference_range: "13.8-17.5", section: "hematology" },
  { name: "H.C.T", abbr: "H.C.T", value: "40.6", unit: "%", reference_range: "41.5-50.4", section: "hematology" },
  { name: "M.C.V", abbr: "M.C.V", value: "94", unit: "fL", reference_range: "79.1-94.9", section: "hematology" },
  { name: "M.C.H", abbr: "M.C.H", value: "32", unit: "pg", reference_range: "27.5-33.2", section: "hematology" },
  { name: "MCHC", abbr: "MCHC", value: "34", unit: "g/dL", reference_range: "32.1-36.1", section: "hematology" },
  { name: "PLT", abbr: "PLT", value: "209", unit: "x1000/µL", reference_range: "150-450", section: "hematology" },
  { name: "RDW", abbr: "RDW", value: "15.2", unit: "%", reference_range: "10-15.6", section: "hematology" },
  { name: "Neutrophil", abbr: null, value: "46", unit: "%", reference_range: null, section: "hematology" },
  { name: "Lymphocyte", abbr: null, value: "50", unit: "%", reference_range: null, section: "hematology" },
  { name: "Monocyte", abbr: null, value: "3", unit: "%", reference_range: null, section: "hematology" },
  { name: "Eosinophil", abbr: null, value: "1", unit: "%", reference_range: null, section: "hematology" },
  { name: "B.U.N", abbr: "B.U.N", value: "8.0", unit: "mg/dL", reference_range: "5-23", section: "biochemistry" },
  { name: "Creatinine (serum)", abbr: null, value: "1.2", unit: "mg/dL", reference_range: "0.7-1.4", section: "biochemistry" },
  { name: "A.S.T.(SGOT)", abbr: "A.S.T.(SGOT)", value: "18", unit: "U/L", reference_range: "Up to 40", section: "biochemistry" },
  { name: "A.L.T(SGPT)", abbr: "A.L.T(SGPT)", value: "21", unit: "U/L", reference_range: "Up to 40", section: "biochemistry" },
  { name: "Alk.Phosphatase(ALP)", abbr: "Alk.Phosphatase(ALP)", value: "283", unit: "IU/L", reference_range: "80-468", section: "biochemistry" },
  { name: "Bilirubin Total", abbr: null, value: "0.4", unit: "mg/dl", reference_range: "0.2-1.2", section: "biochemistry" },
  { name: "Bilirubin Direct", abbr: null, value: "0.2", unit: "mg/dL", reference_range: "<0.5", section: "biochemistry" },
];

test("real sheet: 20 tests, grouped by section, 15 normal / 1 low / 4 unknown", () => {
  const { tests, limitations } = processTests(REAL_SHEET, "");
  assert.equal(tests.length, 20);
  assert.deepEqual(
    tests.filter((t) => t.section === "hematology").length,
    13,
  );
  assert.deepEqual(
    tests.filter((t) => t.section === "biochemistry").length,
    7,
  );
  assert.equal(tests.filter((t) => t.status === "normal").length, 15);
  assert.equal(tests.filter((t) => t.status === "low").length, 1);
  assert.equal(tests.filter((t) => t.status === "high").length, 0);
  assert.equal(tests.filter((t) => t.status === "unknown").length, 4);
  // Dotted abbreviations resolve to real Persian names + real explanations.
  assert.equal(tests[0].name, "گلبول سفید");
  assert.equal(tests[1].name, "گلبول قرمز");
  assert.equal(tests[3].name, "هماتوکریت");
  assert.equal(tests[4].name, "حجم متوسط گلبول قرمز");
  assert.equal(tests[13].name, "نیتروژن اوره خون");
  assert.equal(tests[14].name, "کراتینین");
  assert.equal(tests[15].name, "آسپارتات آمینوترانسفراز");
  assert.equal(tests[16].name, "آلانین آمینوترانسفراز");
  assert.equal(tests[17].name, "آلکالن فسفاتاز");
  assert.ok(!tests[0].explanation.includes("یکی از موارد برگه آزمایش"));
  // The only low test is HCT, with the 0.9 gap quantified.
  assert.equal(tests[3].status, "low");
  assert.ok(tests[3].explanation.includes("0.9 % کمتر از حد پایین بازه است"));
  // Differential rows keep their values, stay unknown, no range comparison.
  assert.equal(tests[9].value, "46");
  assert.equal(tests[9].status, "unknown");
  assert.ok(tests[9].explanation.includes("بازه روی برگه نیست"));
  // "Up to 40" and "<0.5" ranges validate as normal.
  assert.equal(tests[15].status, "normal");
  assert.equal(tests[19].status, "normal");
  assert.equal(limitations.length, 4);
});

test("mergeRanges refills only the missing ranges, never values", () => {
  const original = [
    { name: "Hb", abbr: "Hb", value: "13.9", unit: "g/dL", reference_range: null },
    { name: "Neutrophil", abbr: null, value: "46", unit: "%", reference_range: null },
  ];
  const retry = [
    { name: "Hb", abbr: "Hb", value: "13.9", unit: "g/dL", reference_range: "13.8-17.5" },
    { name: "Neutrophil", abbr: null, value: "46", unit: "%", reference_range: null },
  ];
  const merged = mergeRanges(original, retry);
  assert.equal(merged[0].reference_range, "13.8-17.5");
  assert.equal(merged[0].value, "13.9");
  assert.equal(merged[1].reference_range, null);
});

test("his run: all ranges dropped, then retry restores 15/1/4", () => {
  // Regression for the deployed v1 run: 20 tests, values correct, every
  // reference_range null, every explanation generic. The retry merge must
  // restore the ranges instead of displaying 20 unknowns.
  const dropped = REAL_SHEET.map((t) => ({ ...t, reference_range: null }));
  const { tests: bad } = processTests(dropped, "");
  assert.ok(bad.every((t) => t.status === "unknown"));
  assert.ok(bad.every((t) => t.reference_range === null));
  const merged = mergeRanges(dropped, REAL_SHEET);
  const { tests, limitations } = processTests(merged, "");
  assert.equal(tests.filter((t) => t.status === "normal").length, 15);
  assert.equal(tests.filter((t) => t.status === "low").length, 1);
  assert.equal(tests.filter((t) => t.status === "unknown").length, 4);
  assert.equal(limitations.length, 4);
  assert.ok(!tests[0].explanation.includes("یکی از موارد برگه آزمایش"));
});

test("Persian names from the model get real explanations", () => {
  const { tests } = processTests(
    [{ name: "شمارش گلبول سفید", abbr: null, value: "4.5", unit: "x1000/µL", reference_range: "4.5-11.5", section: "hematology" }],
    "",
  );
  assert.equal(tests[0].name, "گلبول سفید");
  assert.ok(tests[0].explanation.includes("گلبول‌های سفید"));
  assert.equal(tests[0].status, "normal");
});

test("needsRangesRetry: systematic range loss triggers, real sheet does not", () => {
  // His run on the deployed v1: 20 valued tests, 0 ranges -> retry.
  const dropped = processTests(REAL_SHEET.map((t) => ({ ...t, reference_range: null })), "").tests;
  assert.equal(needsRangesRetry(dropped), true);
  // Partial systematic loss (3 of 20 ranged) is also a failure, not "unknown".
  const partial = processTests(
    REAL_SHEET.map((t, i) => ({ ...t, reference_range: i < 3 ? t.reference_range : null })),
    "",
  ).tests;
  assert.equal(needsRangesRetry(partial), true);
  // The real sheet (16 of 20 ranged; only the differential has none) -> no retry.
  assert.equal(needsRangesRetry(processTests(REAL_SHEET, "").tests), false);
  // No valued tests at all -> nothing to retry for.
  assert.equal(needsRangesRetry(processTests([{ name: "Hb", value: null }], "").tests), false);
});

test("buildPrompt anchors the model to the range column (v1 regression)", () => {
  // Root cause of the reproduced failure: the v1 prompt gave the model
  // no examples and no column instructions, so it nulled every range
  // and the differential units. The prompt must name the column,
  // show the range formats, work an example row, and give the
  // differential rows their % unit.
  const prompt = buildPrompt();
  assert.ok(prompt.includes("Reference Interval"));
  assert.ok(prompt.includes("4.5-11.5"));
  assert.ok(prompt.includes("Up to 40"));
  assert.ok(prompt.includes("<0.5"));
  assert.ok(prompt.includes("W.B.C."));
  assert.ok(prompt.includes("Neutrophil"));
  assert.ok(prompt.includes("%"));
  assert.ok(prompt.includes("گلبول سفید"));
});

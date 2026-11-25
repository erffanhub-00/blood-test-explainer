import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath, URL as NodeURL } from "node:url";
import {
  buildExplanation,
  displayRange,
  normalizeDigits,
  parseRange,
  parseValue,
  processTests,
  validateStatus,
} from "../src/validation.js";

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
  );
  assert.equal(
    explanation,
    "کلسترول نوعی چربی خون است. مقدار 210 بالاتر از بازه 0 تا 200 روی برگه است.",
  );
  assert.ok(!explanation.includes("در محدوده است"));
});

test("no range and unreadable value get honest explanations", () => {
  assert.equal(
    buildExplanation("85", null, "unknown", "فریتین ذخیره آهن بدن را نشان می‌دهد."),
    "فریتین ذخیره آهن بدن را نشان می‌دهد. مقدار 85 ثبت شده است، اما بازه روی برگه نیست، برای تفسیر به پزشک مراجعه کن.",
  );
  assert.equal(
    buildExplanation(null, "0-150", "unknown", "تری‌گلیسرید نوعی چربی خون است."),
    "تری‌گلیسرید نوعی چربی خون است. مقدار آن خوانا نیست.",
  );
});

// The sample used by the "برگه نمونه" button. Raw rows as the model
// would return them; the processed output must equal public/sample.json.
const RAW_SAMPLE = [
  { name: "WBC", abbr: "WBC", value: "6.2", unit: "10^3/uL", reference_range: "4.0-11.0" },
  { name: "RBC", abbr: "RBC", value: "4.8", unit: "10^6/uL", reference_range: "4.2-5.8" },
  { name: "Hb", abbr: "Hb", value: "13.5", unit: "g/dL", reference_range: "12.0-16.0" },
  { name: "HCT", abbr: "HCT", value: "40.6", unit: "%", reference_range: "36.0-48.0" },
  { name: "PLT", abbr: "PLT", value: "250", unit: "10^3/uL", reference_range: "150-400" },
  { name: "Glucose", abbr: "Glucose", value: "95", unit: "mg/dL", reference_range: "70-99" },
  { name: "Cholesterol", abbr: "Cholesterol", value: "210", unit: "mg/dL", reference_range: "0-200" },
  { name: "Ferritin", abbr: "Ferritin", value: "85", unit: "ng/mL", reference_range: null },
  { name: "TG", abbr: "TG", value: null, unit: "mg/dL", reference_range: "0-150" },
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

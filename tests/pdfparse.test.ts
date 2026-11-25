import { test } from "node:test";
import assert from "node:assert/strict";
import { extractPdfText, parsePdfTable, shouldUseDeterministicParse } from "../src/pdfparse.js";
import { processTests } from "../src/validation.js";
import { makeTextPdf } from "./make-pdf.js";

// Erfan's real 20-test Dena Clinic sheet, as extracted PDF text:
// section headers, dotted abbreviations, "Up to 40 / Child:20-60",
// "<0.5", and 4 differential rows with no range.
const SHEET_TEXT = [
  "Hematology",
  "W.B.C. 4.5 x1000/µL 4.5-11.5",
  "R.B.C. 4.32 x1000000/µL 4.21-5.91",
  "Hb 13.9 g/dL 13.8-17.5",
  "H.C.T 40.6 % 41.5-50.4",
  "M.C.V 94 fL 79.1-94.9",
  "M.C.H 32 pg 27.5-33.2",
  "MCHC 34 g/dL 32.1-36.1",
  "PLT 209 x1000/µL 150-450",
  "RDW 15.2 % 10-15.6",
  "Neutrophil 46",
  "Lymphocyte 50",
  "Monocyte 3",
  "Eosinophil 1",
  "Biochemistry",
  "B.U.N 8.0 mg/dL 5-23",
  "Creatinine (serum) 1.2 mg/dL 0.7-1.4",
  "A.S.T.(SGOT) 18 U/L Up to 40 / Child:20-60",
  "A.L.T(SGPT) 21 U/L Up to 40",
  "Alk.Phosphatase(ALP) 283 IU/L 80-468",
  "Bilirubin Total 0.4 mg/dl 0.2-1.2",
  "Bilirubin Direct 0.2 mg/dL <0.5",
].join("\n");

test("parsePdfTable: real sheet text -> 20 tests, 16 ranges, HCT low", () => {
  const raw = parsePdfTable(SHEET_TEXT);
  assert.equal(raw.length, 20);
  assert.equal(raw.filter((t) => t.reference_range).length, 16);
  assert.equal(raw[0].name, "W.B.C.");
  assert.equal(raw[0].value, "4.5");
  assert.equal(raw[0].unit, "x1000/µL");
  assert.equal(raw[0].reference_range, "4.5-11.5");
  assert.equal(raw[0].section, "hematology");
  assert.equal(raw[3].value, "40.6");
  assert.equal(raw[3].reference_range, "41.5-50.4");
  // Differential rows: value only, no unit, no range.
  assert.equal(raw[9].name, "Neutrophil");
  assert.equal(raw[9].value, "46");
  assert.equal(raw[9].unit, null);
  assert.equal(raw[9].reference_range, null);
  // "Up to 40 / Child:20-60" keeps only the adult bound; "<0.5" kept.
  assert.equal(raw[15].reference_range, "Up to 40");
  assert.equal(raw[15].unit, "U/L");
  assert.equal(raw[19].reference_range, "<0.5");
  assert.equal(raw[13].section, "biochemistry");

  const { tests, limitations } = processTests(raw, SHEET_TEXT);
  assert.equal(tests.filter((t) => t.status === "normal").length, 15);
  assert.equal(tests.filter((t) => t.status === "low").length, 1);
  assert.equal(tests.filter((t) => t.status === "unknown").length, 4);
  assert.equal(tests[3].status, "low");
  assert.equal(tests[0].name, "گلبول سفید");
  assert.equal(limitations.length, 4);
});

test("parsePdfTable handles Persian digits and dotted abbreviations", () => {
  const raw = parsePdfTable("W.B.C. ۴.۵ x1000/µL ۴.۵-۱۱.۵\nHb ۱۳.۹ g/dL 13.8-17.5");
  assert.equal(raw.length, 2);
  assert.equal(raw[0].value, "4.5");
  assert.equal(raw[0].reference_range, "4.5-11.5");
  assert.equal(raw[1].value, "13.9");
});

test("parsePdfTable skips headers and patient lines, keeps Testosterone", () => {
  const raw = parsePdfTable([
    "Test Result Unit Reference Range",
    "Patient: Ali",
    "Date 1405/06/29",
    "Testosterone 5.2 ng/mL 2.5-8.5",
    "Page 1",
  ].join("\n"));
  assert.equal(raw.length, 1);
  assert.equal(raw[0].name, "Testosterone");
  assert.equal(raw[0].reference_range, "2.5-8.5");
});

test("shouldUseDeterministicParse: real sheet yes, thin parse no", () => {
  assert.equal(shouldUseDeterministicParse(parsePdfTable(SHEET_TEXT)), true);
  assert.equal(shouldUseDeterministicParse(parsePdfTable("WBC 6.2 4.0-11.0\nHb 13.5 12-16")), false);
  const noRanges = parsePdfTable(SHEET_TEXT).map((t) => ({ ...t, reference_range: null }));
  assert.equal(shouldUseDeterministicParse(noRanges), false);
});

test("extractPdfText reads a text PDF in code (unpdf, zero AI)", async () => {
  const ascii = SHEET_TEXT.replace(/µ/g, "u");
  const bytes = makeTextPdf(ascii.split("\n"));
  const text = await extractPdfText(bytes);
  assert.ok(text.includes("W.B.C. 4.5 x1000/uL 4.5-11.5"));
  assert.ok(text.includes("Bilirubin Direct 0.2 mg/dL <0.5"));
  const raw = parsePdfTable(text);
  assert.equal(raw.length, 20);
  assert.equal(shouldUseDeterministicParse(raw), true);
});

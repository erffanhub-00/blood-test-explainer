import { test } from "node:test";
import assert from "node:assert/strict";
import { analyze } from "../src/analyze.js";
import type { Env } from "../src/types.js";
import { makeTextPdf } from "./make-pdf.js";

// The real 20-test sheet with all ranges dropped (his run): values are
// correct, every reference_range is null, so every fallback pass fires.
const DROPPED = [
  { name: "W.B.C.", abbr: "W.B.C.", value: "4.5", unit: "x1000/uL", reference_range: null, section: "hematology" },
  { name: "R.B.C.", abbr: "R.B.C.", value: "4.32", unit: "x1000000/uL", reference_range: null, section: "hematology" },
  { name: "Hb", abbr: "Hb", value: "13.9", unit: "g/dL", reference_range: null, section: "hematology" },
  { name: "H.C.T", abbr: "H.C.T", value: "40.6", unit: "%", reference_range: null, section: "hematology" },
  { name: "M.C.V", abbr: "M.C.V", value: "94", unit: "fL", reference_range: null, section: "hematology" },
  { name: "M.C.H", abbr: "M.C.H", value: "32", unit: "pg", reference_range: null, section: "hematology" },
  { name: "MCHC", abbr: "MCHC", value: "34", unit: "g/dL", reference_range: null, section: "hematology" },
  { name: "PLT", abbr: "PLT", value: "209", unit: "x1000/uL", reference_range: null, section: "hematology" },
  { name: "RDW", abbr: "RDW", value: "15.2", unit: "%", reference_range: null, section: "hematology" },
  { name: "Neutrophil", abbr: null, value: "46", unit: "%", reference_range: null, section: "hematology" },
  { name: "Lymphocyte", abbr: null, value: "50", unit: "%", reference_range: null, section: "hematology" },
  { name: "Monocyte", abbr: null, value: "3", unit: "%", reference_range: null, section: "hematology" },
  { name: "Eosinophil", abbr: null, value: "1", unit: "%", reference_range: null, section: "hematology" },
  { name: "B.U.N", abbr: "B.U.N", value: "8.0", unit: "mg/dL", reference_range: null, section: "biochemistry" },
  { name: "Creatinine (serum)", abbr: null, value: "1.2", unit: "mg/dL", reference_range: null, section: "biochemistry" },
  { name: "A.S.T.(SGOT)", abbr: "A.S.T.(SGOT)", value: "18", unit: "U/L", reference_range: null, section: "biochemistry" },
  { name: "A.L.T(SGPT)", abbr: "A.L.T(SGPT)", value: "21", unit: "U/L", reference_range: null, section: "biochemistry" },
  { name: "Alk.Phosphatase(ALP)", abbr: "Alk.Phosphatase(ALP)", value: "283", unit: "IU/L", reference_range: null, section: "biochemistry" },
  { name: "Bilirubin Total", abbr: null, value: "0.4", unit: "mg/dl", reference_range: null, section: "biochemistry" },
  { name: "Bilirubin Direct", abbr: null, value: "0.2", unit: "mg/dL", reference_range: null, section: "biochemistry" },
];

const RANGED = DROPPED.map((t, i) => ({
  ...t,
  reference_range: [
    "4.5-11.5", "4.21-5.91", "13.8-17.5", "41.5-50.4", "79.1-94.9", "27.5-33.2", "32.1-36.1",
    "150-450", "10-15.6", null, null, null, null, "5-23", "0.7-1.4", "Up to 40", "Up to 40",
    "80-468", "0.2-1.2", "<0.5",
  ][i] ?? null,
}));

function mockEnv(response: unknown, calls: { n: number }): Env {
  return {
    AI: {
      run: (async () => {
        calls.n++;
        return { response: JSON.stringify(response) };
      }) as never,
      toMarkdown: (async () => {
        throw new Error("toMarkdown must not be called in this test");
      }) as never,
    },
    ASSETS: {} as Fetcher,
  } as unknown as Env;
}

async function postFile(env: Env, file: File): Promise<{ status: number; body: any }> {
  const form = new FormData();
  form.set("file", file);
  const res = await analyze(
    new Request("http://localhost/api/analyze", { method: "POST", body: form }),
    env,
    "test0001",
  );
  return { status: res.status, body: await res.json() };
}

test("pipeline cap: a sheet that never yields ranges costs at most 8 AI calls", async () => {
  const calls = { n: 0 };
  const env = mockEnv({ summary: "", tests: DROPPED, limitations: [] }, calls);
  const { status, body } = await postFile(env, new File([new Uint8Array([1, 2, 3, 4])], "lab.jpg", { type: "image/jpeg" }));
  assert.equal(status, 200);
  assert.equal(body.tests.length, 20);
  assert.ok(body.tests.every((t: any) => t.status === "unknown"));
  assert.ok(calls.n <= 8, `expected at most 8 AI calls, got ${calls.n}`);
  assert.ok(calls.n >= 5, `expected the fallback passes to run, got ${calls.n}`);
});

test("pipeline early exit: ranges on pass 1 cost exactly 1 AI call", async () => {
  const calls = { n: 0 };
  const env = mockEnv({ summary: "", tests: RANGED, limitations: [] }, calls);
  const { status, body } = await postFile(env, new File([new Uint8Array([1, 2, 3, 4])], "lab.jpg", { type: "image/jpeg" }));
  assert.equal(status, 200);
  assert.equal(calls.n, 1);
  assert.equal(body.tests.filter((t: any) => t.status === "normal").length, 15);
  assert.equal(body.tests.filter((t: any) => t.status === "low").length, 1);
  assert.equal(body.tests.filter((t: any) => t.status === "unknown").length, 4);
});

test("PDF deterministic path: text PDF costs 0 AI calls, 15/1/4", async () => {
  const calls = { n: 0 };
  const env = mockEnv({ summary: "", tests: [], limitations: [] }, calls);
  const lines = [
    "Hematology",
    "W.B.C. 4.5 x1000/uL 4.5-11.5",
    "R.B.C. 4.32 x1000000/uL 4.21-5.91",
    "Hb 13.9 g/dL 13.8-17.5",
    "H.C.T 40.6 % 41.5-50.4",
    "M.C.V 94 fL 79.1-94.9",
    "M.C.H 32 pg 27.5-33.2",
    "MCHC 34 g/dL 32.1-36.1",
    "PLT 209 x1000/uL 150-450",
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
  ];
  const pdf = makeTextPdf(lines);
  const { status, body } = await postFile(env, new File([pdf], "lab.pdf", { type: "application/pdf" }));
  assert.equal(status, 200);
  assert.equal(calls.n, 0, "deterministic PDF path must not call AI");
  assert.equal(body.tests.length, 20);
  assert.equal(body.tests.filter((t: any) => t.status === "normal").length, 15);
  assert.equal(body.tests.filter((t: any) => t.status === "low").length, 1);
  assert.equal(body.tests.filter((t: any) => t.status === "unknown").length, 4);
  assert.equal(body.tests[0].name, "گلبول سفید");
});

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

const RANGE_LINES = RANGED.map((t) => `${t.name} — ${t.reference_range ?? "(no range)"}`).join("\n");

function jsonResponse(tests: unknown): { response: string } {
  return { response: JSON.stringify({ summary: "", tests, limitations: [] }) };
}

function userText(options: any): string {
  const c = options?.messages?.[1]?.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    return c.filter((p: any) => p.type === "text").map((p: any) => p.text).join("\n");
  }
  return "";
}

/** Mock AI that answers by prompt kind. A "hang" route never resolves. */
function routingMockEnv(
  routes: Partial<Record<string, unknown>>,
  calls: { n: number; maxActive: number },
): Env {
  let active = 0;
  return {
    AI: {
      run: (async (_model: string, options: any) => {
        calls.n++;
        active++;
        calls.maxActive = Math.max(calls.maxActive, active);
        try {
          // Small delay so concurrent round-mates actually overlap.
          await new Promise((r) => setTimeout(r, 10));
          const text = userText(options);
          let kind = "full";
          if (text.includes("فقط ستون بازه مرجع")) kind = "range_column";
          else if (text.includes("فقط بخش هماتولوژی")) kind = "section_hematology";
          else if (text.includes("فقط بخش بیوشیمی")) kind = "section_biochemistry";
          else if (text.includes("در پاسخ قبلی محدوده مرجع")) kind = "ranges_only";
          else if (text.includes("متن رونویسی‌شده از برگه")) kind = "structure";
          else if (text.includes("رونویسی کن")) kind = "transcription";
          const res = routes[kind] ?? routes.full;
          if (res === "hang") await new Promise(() => {});
          return res;
        } finally {
          active--;
        }
      }) as never,
      toMarkdown: (async () => {
        throw new Error("toMarkdown must not be called in this test");
      }) as never,
    },
    ASSETS: {} as Fetcher,
  } as unknown as Env;
}

function simpleMockEnv(response: unknown, calls: { n: number }): Env {
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

async function postFile(
  env: Env,
  file: File,
  opts?: { callTimeoutMs?: number },
): Promise<{ status: number; body: any; events: any[] }> {
  const form = new FormData();
  form.set("file", file);
  const res = await analyze(
    new Request("http://localhost/api/analyze", { method: "POST", body: form }),
    env,
    "test0001",
    opts ?? {},
  );
  const text = await res.text();
  const contentType = res.headers.get("content-type") || "";
  if (contentType.includes("ndjson")) {
    const events = text.split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const doneEv = events.find((e) => e.done);
    return { status: res.status, body: doneEv ? doneEv.result : null, events };
  }
  return { status: res.status, body: text ? JSON.parse(text) : null, events: [] };
}

function counts(body: any): { normal: number; low: number; unknown: number } {
  return {
    normal: body.tests.filter((t: any) => t.status === "normal").length,
    low: body.tests.filter((t: any) => t.status === "low").length,
    unknown: body.tests.filter((t: any) => t.status === "unknown").length,
  };
}

const JPG = new File([new Uint8Array([1, 2, 3, 4])], "lab.jpg", { type: "image/jpeg" });

test("round 1 parallel merge: full without ranges + range-column-only restores them in 2 concurrent calls", async () => {
  const calls = { n: 0, maxActive: 0 };
  const env = routingMockEnv(
    { full: jsonResponse(DROPPED), range_column: { response: RANGE_LINES } },
    calls,
  );
  const { status, body } = await postFile(env, JPG);
  assert.equal(status, 200);
  assert.equal(body.tests.length, 20);
  assert.deepEqual(counts(body), { normal: 15, low: 1, unknown: 4 });
  assert.equal(calls.n, 2, "round 1 is exactly two concurrent calls, then early exit");
  assert.ok(calls.maxActive >= 2, `expected the two round-1 calls to overlap, maxActive=${calls.maxActive}`);
});

test("pipeline early exit: ranges on round 1 cost exactly 2 AI calls (full + range-column in parallel)", async () => {
  const calls = { n: 0 };
  const env = simpleMockEnv({ summary: "", tests: RANGED, limitations: [] }, calls);
  const { status, body } = await postFile(env, JPG);
  assert.equal(status, 200);
  assert.equal(calls.n, 2);
  assert.deepEqual(counts(body), { normal: 15, low: 1, unknown: 4 });
});

test("pipeline cap: a sheet that never yields ranges costs at most 8 AI calls", async () => {
  const calls = { n: 0 };
  const env = simpleMockEnv({ summary: "", tests: DROPPED, limitations: [] }, calls);
  const { status, body } = await postFile(env, JPG);
  assert.equal(status, 200);
  assert.equal(body.tests.length, 20);
  assert.ok(body.tests.every((t: any) => t.status === "unknown"));
  assert.ok(calls.n <= 8, `expected at most 8 AI calls, got ${calls.n}`);
  assert.ok(calls.n >= 5, `expected the fallback passes to run, got ${calls.n}`);
});

test("timeout: a hanging range-column call is skipped after the timeout and the pipeline still returns the best result", async () => {
  const calls = { n: 0, maxActive: 0 };
  const env = routingMockEnv(
    {
      full: jsonResponse(DROPPED),
      range_column: "hang",
      section_hematology: jsonResponse(RANGED),
      section_biochemistry: jsonResponse(RANGED),
      ranges_only: jsonResponse(RANGED),
    },
    calls,
  );
  const started = Date.now();
  const { status, body } = await postFile(env, JPG, { callTimeoutMs: 50 });
  assert.ok(Date.now() - started < 5000, "the hanging call must not stall the pipeline");
  assert.equal(status, 200);
  assert.deepEqual(counts(body), { normal: 15, low: 1, unknown: 4 });
  assert.equal(calls.n, 5, "full + range-column (timed out) + 3 round-2 calls");
});

test("SSE event format: stage events in order, then done with the result", async () => {
  const calls = { n: 0 };
  const env = simpleMockEnv({ summary: "", tests: RANGED, limitations: [] }, calls);
  const { status, body, events } = await postFile(env, JPG);
  assert.equal(status, 200);
  assert.equal(events[0].stage, "reading_table");
  assert.equal(events[0].progress, 25);
  const doneEv = events[events.length - 1];
  assert.equal(doneEv.done, true);
  assert.equal(doneEv.stopReason, "good_enough");
  assert.equal(doneEv.result.tests.length, 20);
  assert.equal(body.tests.length, 20);
});

test("PDF deterministic path: text PDF costs 0 AI calls, 15/1/4", async () => {
  const calls = { n: 0 };
  const env = simpleMockEnv({ summary: "", tests: [], limitations: [] }, calls);
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
  assert.deepEqual(counts(body), { normal: 15, low: 1, unknown: 4 });
  assert.equal(body.tests[0].name, "گلبول سفید");
});

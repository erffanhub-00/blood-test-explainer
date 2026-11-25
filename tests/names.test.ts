import { test } from "node:test";
import assert from "node:assert/strict";
import { canonical, fixSpelling } from "../src/names.js";

test("canonical names map abbreviations to Persian", () => {
  assert.equal(canonical("WBC", null)?.[0], "گلبول سفید");
  assert.equal(canonical("Hb", null)?.[0], "هموگلوبین");
  assert.equal(canonical("Cholesterol", null)?.[0], "کلسترول کل");
  assert.equal(canonical("Cr", null)?.[0], "کراتینین");
  assert.equal(canonical(null, "Ferritin")?.[0], "فریتین");
  assert.equal(canonical("XYZ", "Unknown thing"), null);
});

test("dotted abbreviations on a real sheet resolve", () => {
  // Lab sheets print abbreviations with dots: W.B.C., H.C.T, B.U.N, ...
  assert.equal(canonical("W.B.C.", null)?.[0], "گلبول سفید");
  assert.equal(canonical("R.B.C.", null)?.[0], "گلبول قرمز");
  assert.equal(canonical("H.C.T", null)?.[0], "هماتوکریت");
  assert.equal(canonical("M.C.V", null)?.[0], "حجم متوسط گلبول قرمز");
  assert.equal(canonical("M.C.H", null)?.[0], "هموگلوبین متوسط هر گلبول");
  assert.equal(canonical("B.U.N", null)?.[0], "نیتروژن اوره خون");
  assert.equal(canonical("A.S.T.(SGOT)", null)?.[0], "آسپارتات آمینوترانسفراز");
  assert.equal(canonical("A.L.T(SGPT)", null)?.[0], "آلانین آمینوترانسفراز");
  assert.equal(canonical(null, "W.B.C.")?.[0], "گلبول سفید");
});

test("compound names match by token", () => {
  assert.equal(canonical(null, "Creatinine (serum)")?.[0], "کراتینین");
  assert.equal(canonical(null, "Alk.Phosphatase(ALP)")?.[0], "آلکالن فسفاتاز");
  assert.equal(canonical(null, "Bilirubin Total")?.[0], "بیلی‌روبین کل");
  assert.equal(canonical(null, "Bilirubin Direct")?.[0], "بیلی‌روبین مستقیم");
});

test("Persian display names resolve, not generic fallback", () => {
  // The model sometimes returns Persian names instead of English abbrs.
  assert.equal(canonical(null, "شمارش گلبول سفید")?.[0], "گلبول سفید");
  assert.equal(canonical(null, "شمارش گلبول قرمز")?.[0], "گلبول قرمز");
  assert.equal(canonical(null, "هموگلوبین")?.[0], "هموگلوبین");
  assert.equal(canonical(null, "هماتوکریت")?.[0], "هماتوکریت");
  assert.equal(canonical(null, "هموگلوبین متوسط گلبول قرمز")?.[0], "هموگلوبین متوسط هر گلبول");
  assert.equal(canonical(null, "غلظت هموگلوبین متوسط گلبول قرمز")?.[0], "غلظت هموگلوبین متوسط");
  assert.equal(canonical(null, "شمارش پلاکت")?.[0], "پلاکت");
  assert.equal(canonical(null, "پخش شدگی اندازه گلبول های قرمز")?.[0], "پراکندگی اندازه گلبول‌ها");
  assert.equal(canonical(null, "اوره خون")?.[0], "نیتروژن اوره خون");
  assert.equal(canonical(null, "کراتینین سرم")?.[0], "کراتینین");
  assert.equal(canonical(null, "بیلی روبین کل")?.[0], "بیلی‌روبین کل");
  assert.equal(canonical(null, "بیلی روبین مستقیم")?.[0], "بیلی‌روبین مستقیم");
});

test("spelling fixes correct only the known mistakes", () => {
  assert.equal(fixSpelling("آزوفیل"), "ائوزینوفیل");
  assert.equal(fixSpelling("لیمفوسیت"), "لنفوسیت");
  assert.equal(fixSpelling("هیموگلوبین"), "هموگلوبین");
  assert.equal(fixSpelling("آلکالین فسفاتاز"), "آلکالن فسفاتاز");
  assert.equal(fixSpelling("هیولای سفید"), "گلبول سفید");
  // Plain correct text passes through untouched.
  assert.equal(fixSpelling("هموگلوبین 13.5"), "هموگلوبین 13.5");
});

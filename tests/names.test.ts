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

test("spelling fixes correct only the known mistakes", () => {
  assert.equal(fixSpelling("آزوفیل"), "ائوزینوفیل");
  assert.equal(fixSpelling("لیمفوسیت"), "لنفوسیت");
  assert.equal(fixSpelling("هیموگلوبین"), "هموگلوبین");
  assert.equal(fixSpelling("آلکالین فسفاتاز"), "آلکالن فسفاتاز");
  assert.equal(fixSpelling("هیولای سفید"), "گلبول سفید");
  // Plain correct text passes through untouched.
  assert.equal(fixSpelling("هموگلوبین 13.5"), "هموگلوبین 13.5");
});

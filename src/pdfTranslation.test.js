import test from "node:test";
import assert from "node:assert/strict";
import { normalizePdfSelection, normalizedSelectionAnchor } from "./pdfTranslation.js";

test("normalizes PDF text selections without leaking unbounded page text", () => {
  assert.equal(normalizePdfSelection("  temporal\n  interference  "), "temporal interference");
  assert.equal(normalizePdfSelection("a"), "");
  assert.equal(normalizePdfSelection("abcdef", 4), "abcd");
});

test("stores selection anchors as zoom-independent page percentages", () => {
  assert.deepEqual(
    normalizedSelectionAnchor(
      { left: 200, bottom: 300, width: 100 },
      { left: 100, top: 100, width: 500, height: 1000 }
    ),
    { x: 30, y: 20 }
  );
});

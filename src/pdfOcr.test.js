import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeOcrText,
  normalizeOcrBox,
  ocrRegionCacheKey,
  protectOcrText,
  restoreProtectedText
} from "./pdfOcr.js";

test("normalizes OCR text while retaining paragraph breaks", () => {
  assert.equal(normalizeOcrText("  A   line\n\n\n B  "), "A line\n\n B");
});

test("protects formulas and citation/figure identifiers from translation", () => {
  const original = "The model $x_i = y_i$ improves [1, 2]. See Fig. 3 and Eq. (4).";
  const protectedText = protectOcrText(original);
  assert.notEqual(protectedText.text, original);
  assert.equal(protectedText.tokens.length, 4);
  assert.match(protectedText.text, /__SCHOLARLOOP_KEEP_0__/);
  assert.equal(restoreProtectedText(`translated ${protectedText.text}`, protectedText.tokens), `translated ${original}`);
});

test("uses zoom-independent keys for OCR regions", () => {
  assert.deepEqual(normalizeOcrBox({ left: 0.4, top: 0.2, right: 0.8, bottom: 0.6 }), {
    left: 0.4, top: 0.2, right: 0.8, bottom: 0.6, width: 0.4, height: 0.4
  });
  assert.equal(ocrRegionCacheKey(2, { left: 0.4, top: 0.2, right: 0.8, bottom: 0.6 }), "p2:0.4,0.2,0.4,0.4");
});

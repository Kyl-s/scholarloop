import test from "node:test";
import assert from "node:assert/strict";
import { pickSelectionAnchorRect, usesNativePdfSelection } from "./pdfTextSelection.js";

test("anchors the translation popover on the last visible selection line", () => {
  const last = pickSelectionAnchorRect(
    [
      { left: 10, top: 10, width: 80, height: 12 },
      { left: 10, top: 28, width: 40, height: 12 }
    ],
    { left: 10, top: 10, width: 80, height: 30 }
  );
  assert.deepEqual(last, { left: 10, top: 28, width: 40, height: 12 });
});

test("ignores empty client rects when choosing a selection anchor", () => {
  const fallback = { left: 0, top: 0, width: 10, height: 10 };
  assert.equal(
    pickSelectionAnchorRect([{ left: 0, top: 0, width: 0, height: 0 }], fallback),
    fallback
  );
});

test("treats Chromium 148+ as having native PDF selection", () => {
  assert.equal(
    usesNativePdfSelection({ navigator: { userAgent: "Mozilla/5.0 Chrome/148.0.0.0" } }),
    true
  );
  assert.equal(
    usesNativePdfSelection({ navigator: { userAgent: "Mozilla/5.0 Chrome/140.0.0.0" } }),
    false
  );
});

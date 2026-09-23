import test from "node:test";
import assert from "node:assert/strict";
import { createPdfRenderSequence } from "./pdfRenderState.js";

test("only the newest PDF render sequence remains current", () => {
  const sequence = createPdfRenderSequence();
  const first = sequence.next();
  const second = sequence.next();

  assert.equal(sequence.isCurrent(first), false);
  assert.equal(sequence.isCurrent(second), true);
});

test("a render sequence starts invalid until a render begins", () => {
  const sequence = createPdfRenderSequence();

  assert.equal(sequence.isCurrent(1), false);
});

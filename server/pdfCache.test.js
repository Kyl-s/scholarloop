import test from "node:test";
import assert from "node:assert/strict";
import { mergePdfCache, normalizePdfCache } from "./pdfCache.js";

test("normalizes and merges PDF cache without carrying API configuration", () => {
  const first = normalizePdfCache({
    paperId: "paper-1",
    textByPage: { 1: "原文" },
    pageTranslations: { 1: "译文" },
    pageTranslationLayouts: { 1: [{ text: "译文", left: 2, top: 3 }] },
    config: { apiKey: "must-not-persist" }
  }, "paper-1");
  const merged = mergePdfCache(first, {
    textLayoutVersion: 2,
    pageTranslations: { 2: "第二页译文" },
    paragraphTranslations: { "1:0": "段落译文" },
    readingNotes: "第 3 页：方法关键是 TI"
  }, "paper-1");

  assert.equal(merged.config, undefined);
  assert.equal(merged.textLayoutVersion, 2);
  assert.deepEqual(merged.textByPage, { 1: "原文" });
  assert.deepEqual(merged.pageTranslations, { 1: "译文", 2: "第二页译文" });
  assert.deepEqual(merged.pageTranslationLayouts, { 1: [{ text: "译文", left: 2, top: 3 }] });
  assert.equal(merged.paragraphTranslations["1:0"], "段落译文");
  assert.equal(merged.readingNotes, "第 3 页：方法关键是 TI");
  assert.equal(merged.paperId, "paper-1");
});

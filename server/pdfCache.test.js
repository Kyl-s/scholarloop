import test from "node:test";
import assert from "node:assert/strict";
import { listPdfCaches, mergePdfCache, normalizePdfCache } from "./pdfCache.js";

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

test("listPdfCaches 返回数组", () => {
  const caches = listPdfCaches();
  assert.equal(Array.isArray(caches), true);
  for (const cache of caches) {
    assert.equal(typeof cache.paperId, "string");
    assert.equal(typeof cache.readingNotes, "string");
  }
});

test("drops obsolete visual layout cache data", () => {
  const cache = normalizePdfCache({
    visualPageTranslationLayouts: { obsolete: { pages: { 1: [{ text: "旧译文" }] } } }
  }, "paper-visual");
  assert.equal(cache.visualPageTranslationLayouts, undefined);
});

test("保留普通和页面图片辅助两套版式任务缓存", () => {
  const normal = normalizePdfCache({
    layoutTranslationJobs: {
      normal: {
        jobId: "normal-job",
        sourceSha256: "source-a",
        identityHash: "identity-normal",
        model: "model-a",
        baseUrl: "https://example.test/v1"
      }
    },
    layoutAssistEnabled: false
  }, "paper-layout");
  const merged = mergePdfCache(normal, {
    layoutTranslationJobs: {
      assisted: {
        jobId: "assisted-job",
        sourceSha256: "source-a",
        identityHash: "identity-assisted",
        model: "model-a",
        baseUrl: "https://example.test/v1"
      }
    },
    layoutAssistEnabled: true
  }, "paper-layout");

  assert.equal(merged.layoutTranslationJobs.normal.jobId, "normal-job");
  assert.equal(merged.layoutTranslationJobs.assisted.jobId, "assisted-job");
  assert.equal(merged.layoutAssistEnabled, true);
});

test("旧版单任务指针仍可读取", () => {
  const cache = normalizePdfCache({ layoutTranslationJobId: "legacy-job" }, "paper-legacy");
  assert.equal(cache.layoutTranslationJobId, "legacy-job");
  assert.deepEqual(cache.layoutTranslationJobs, {});
});

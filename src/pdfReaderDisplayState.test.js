import assert from "node:assert/strict";
import test from "node:test";
import {
  canSelectLayoutDisplayMode,
  canRestoreLayoutTranslation,
  canRestoreCachedDisplayMode,
  initialPdfDisplayMode,
  normalizePdfDisplayMode,
  resolveLayoutPageUrl
} from "./pdfReaderDisplayState.js";

test("saved partial translations remain readable across translator configuration changes", () => {
  const job = {
    jobId: "saved-job", paperId: "paper", sourceSha256: "same-pdf",
    status: "canceled", layoutAssist: { enabled: true },
    identity: { model: "old-model", configFingerprint: "old-settings", engine: { source: "old-engine" } },
    pages: [{ page: 1, status: "completed", monoUrl: "/saved-page" }, { page: 2, status: "queued" }]
  };
  const options = { paperId: "paper", sourceSha256: "same-pdf", layoutAssist: true };
  assert.equal(canRestoreLayoutTranslation(job, options), true);
  assert.equal(canRestoreLayoutTranslation(job, { ...options, paperId: "other" }), false);
  assert.equal(canRestoreLayoutTranslation(job, { ...options, sourceSha256: "different-pdf" }), false);
  assert.equal(canRestoreLayoutTranslation(job, { ...options, layoutAssist: false }), false);
  assert.equal(canRestoreLayoutTranslation(job, { ...options, identityHash: "different-job" }), false);
  assert.equal(canRestoreLayoutTranslation({ ...job, pages: [] }, options), false);
});

test("legacy jobs without translator identity can restore completed pages", () => {
  const job = { jobId: "legacy", paperId: "paper", sourceSha256: "same-pdf", monoUrl: "/saved" };
  assert.equal(canRestoreLayoutTranslation(job, { paperId: "paper", sourceSha256: "same-pdf" }), true);
  assert.equal(canRestoreLayoutTranslation(job, { paperId: "paper", sourceSha256: "" }), false);
});

test("ordinary translation cache cannot select layout display mode", () => {
  assert.equal(initialPdfDisplayMode(), "original");
  assert.equal(canSelectLayoutDisplayMode({ pages: [] }, 1, "translated"), false);
});

test("progressive results select only the current page PDF", () => {
  const result = {
    pages: [
      { page: 1, status: "completed", monoUrl: "/mono-1", dualUrl: "/dual-1" },
      { page: 2, status: "queued", monoUrl: "", dualUrl: "" }
    ]
  };
  assert.equal(resolveLayoutPageUrl(result, 1, "mono").url, "/mono-1");
  assert.equal(resolveLayoutPageUrl(result, 2, "mono").url, "");
  assert.equal(canSelectLayoutDisplayMode(result, 2, "translated"), false);
});

test("dual mode supports legacy whole-document mono fallback", () => {
  assert.equal(resolveLayoutPageUrl({ monoUrl: "/whole-mono" }, 1, "dual").variant, "mono");
});

test("display mode cache values are normalized and require compatible translation content", () => {
  assert.equal(normalizePdfDisplayMode("translated"), "translated");
  assert.equal(normalizePdfDisplayMode("unexpected"), "original");
  assert.equal(initialPdfDisplayMode("bilingual"), "bilingual");
  assert.equal(canRestoreCachedDisplayMode({ pageTranslations: { 1: "译文" } }, "translated"), true);
  assert.equal(canRestoreCachedDisplayMode({ pageTranslations: { 1: "译文" } }, "translated", { compatibleTextCache: false }), false);
  assert.equal(canRestoreCachedDisplayMode({ pageTranslations: { 1: "翻译失败：timeout" } }, "bilingual"), false);
  assert.equal(canRestoreCachedDisplayMode({ paragraphTranslations: { "1:0": "段落译文" } }, "bilingual"), true);
  assert.equal(canRestoreCachedDisplayMode({}, "bilingual"), false);
});

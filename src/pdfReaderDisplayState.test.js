import assert from "node:assert/strict";
import test from "node:test";
import {
  canSelectLayoutDisplayMode,
  initialPdfDisplayMode,
  resolveLayoutPageUrl
} from "./pdfReaderDisplayState.js";

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

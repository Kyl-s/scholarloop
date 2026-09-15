import test from "node:test";
import assert from "node:assert/strict";
import {
  asDirectPdfUrl,
  classifyPdfError,
  clearPdfOpenFailure,
  isDirectPdfUrl,
  PDF_ERROR_KINDS,
  PDF_OPEN_FAILURE_STORAGE_KEY,
  pdfOpenFailureKeys,
  pdfUrlQuality,
  preferPdfUrl,
  readPdfOpenFailure,
  writePdfOpenFailure
} from "./pdfSource.js";

function memoryStorage() {
  const data = new Map();
  return {
    getItem(key) {
      return data.has(key) ? data.get(key) : null;
    },
    setItem(key, value) {
      data.set(key, String(value));
    },
    removeItem(key) {
      data.delete(key);
    }
  };
}

test("classifies auth and anti-bot failures separately", () => {
  assert.equal(classifyPdfError(new Error("403 Forbidden"), { url: "https://example.edu/a.pdf" }).kind, PDF_ERROR_KINDS.auth);
  assert.equal(classifyPdfError(new Error("Cloudflare challenge / 验证码"), { url: "https://example.edu/a.pdf" }).kind, PDF_ERROR_KINDS.antiBot);
});

test("classifies landing pages, non-PDF bodies, and redirect failures", () => {
  assert.equal(classifyPdfError(new Error("返回 text/html 登录页面")).kind, PDF_ERROR_KINDS.landingPage);
  assert.equal(classifyPdfError(new Error("该链接不是可直接下载的 PDF 文件")).kind, PDF_ERROR_KINDS.nonPdf);
  assert.equal(classifyPdfError(new Error("检测到重定向循环")).kind, PDF_ERROR_KINDS.redirect);
});

test("classifies PDF.js parsing errors and exposes a portal hint", () => {
  const result = classifyPdfError(new Error("InvalidPDFException: Invalid PDF structure"), {
    url: "https://example.edu/a.pdf"
  });
  assert.equal(result.kind, PDF_ERROR_KINDS.pdfParse);
  assert.equal(result.canUsePortal, true);
  assert.match(result.hint, /PDF\.js/);
});

test("rejects publisher landing pages as built-in reader pdfUrl", () => {
  assert.equal(pdfUrlQuality("https://ieeexplore.ieee.org/stamp/stamp.jsp?tp=&arnumber=1"), 0);
  assert.equal(asDirectPdfUrl("https://ieeexplore.ieee.org/document/123"), "");
  assert.equal(isDirectPdfUrl("https://www.pnas.org/doi/full/10.1073/pnas.123"), false);
  assert.equal(isDirectPdfUrl("https://arxiv.org/pdf/2301.00001"), true);
  assert.equal(isDirectPdfUrl("/api/pdf/file/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.pdf"), true);
  assert.ok(pdfUrlQuality("https://arxiv.org/pdf/2301.00001.pdf") > pdfUrlQuality("https://example.edu/oa/pdf/paper"));
});

test("prefers a direct PDF over an empty or landing-page url", () => {
  assert.equal(
    preferPdfUrl("", "https://arxiv.org/pdf/2301.00001.pdf"),
    "https://arxiv.org/pdf/2301.00001.pdf"
  );
  assert.equal(
    preferPdfUrl("https://ieeexplore.ieee.org/stamp/stamp.jsp?arnumber=1", "https://arxiv.org/pdf/2301.00001"),
    "https://arxiv.org/pdf/2301.00001"
  );
  assert.equal(
    preferPdfUrl("https://arxiv.org/pdf/2301.00001", "https://openalex.org/works/W1"),
    "https://arxiv.org/pdf/2301.00001"
  );
});

test("failure keys prefer paperId then doi then url", () => {
  assert.deepEqual(
    pdfOpenFailureKeys({ paperId: "p1", doi: "https://doi.org/10.1000/ABC", url: "https://example.edu/a.pdf" }),
    ["paper:p1", "doi:10.1000/abc", "url:https://example.edu/a.pdf"]
  );
});

test("stores a remembered open failure and finds it by any matching key", () => {
  const storage = memoryStorage();
  const info = classifyPdfError(new Error("该链接不是可直接下载的 PDF 文件"), { url: "https://example.edu/a.pdf" });
  writePdfOpenFailure({ url: "https://example.edu/a.pdf" }, info, storage);
  const byUrl = readPdfOpenFailure({ url: "https://example.edu/a.pdf" }, storage);
  assert.equal(byUrl.kind, PDF_ERROR_KINDS.nonPdf);
  writePdfOpenFailure({ paperId: "lib-1", doi: "10.1000/ABC", url: "https://example.edu/a.pdf" }, info, storage);
  const byPaper = readPdfOpenFailure({ paperId: "lib-1" }, storage);
  const byDoi = readPdfOpenFailure({ doi: "10.1000/ABC" }, storage);
  assert.equal(byPaper.kind, PDF_ERROR_KINDS.nonPdf);
  assert.equal(byDoi.message, info.message);
});

test("clears remembered failures after a successful open", () => {
  const storage = memoryStorage();
  const info = classifyPdfError(new Error("403 Forbidden"), { url: "https://example.edu/a.pdf" });
  writePdfOpenFailure({ paperId: "p1", doi: "10.1/x", url: "https://example.edu/a.pdf" }, info, storage);
  clearPdfOpenFailure({ paperId: "p1", doi: "10.1/x", url: "https://example.edu/a.pdf" }, storage);
  assert.equal(readPdfOpenFailure({ paperId: "p1" }, storage), null);
  assert.equal(readPdfOpenFailure({ url: "https://example.edu/a.pdf" }, storage), null);
  assert.equal(storage.getItem(PDF_OPEN_FAILURE_STORAGE_KEY), "{}");
});

test("drops remembered failures older than the TTL", () => {
  const storage = memoryStorage();
  storage.setItem(PDF_OPEN_FAILURE_STORAGE_KEY, JSON.stringify({
    "url:https://example.edu/stale.pdf": {
      kind: PDF_ERROR_KINDS.network,
      label: "网络或下载失败",
      hint: "old",
      message: "timeout",
      url: "https://example.edu/stale.pdf",
      at: "2020-01-01T00:00:00.000Z"
    }
  }));
  assert.equal(readPdfOpenFailure({ url: "https://example.edu/stale.pdf" }, storage), null);
});

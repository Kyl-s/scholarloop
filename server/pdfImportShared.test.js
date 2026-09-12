import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_PDF_BYTES,
  PdfImportError,
  buildImportedPdfPaper,
  downloadPdf,
  guessPdfNameFromUrl,
  mergeImportMetadata,
  normalizeAuthorsInput
} from "./pdfImportShared.js";

// ---------- normalizeAuthorsInput：数组 / 逗号分隔字符串 / 容错 ----------

test("normalizeAuthorsInput accepts arrays and comma separated strings", () => {
  assert.deepEqual(normalizeAuthorsInput(["  Alice ", "Bob", ""]), ["Alice", "Bob"]);
  assert.deepEqual(normalizeAuthorsInput("Alice, Bob; Carol，David；Eve"), ["Alice", "Bob", "Carol", "David", "Eve"]);
  assert.deepEqual(normalizeAuthorsInput([{ name: " Alice " }, "Bob", null]), ["Alice", "Bob"]);
  assert.deepEqual(normalizeAuthorsInput(""), []);
  assert.deepEqual(normalizeAuthorsInput(null), []);
  assert.deepEqual(normalizeAuthorsInput(undefined), []);
});

// ---------- mergeImportMetadata：显式 > Crossref > 提取值 ----------

test("mergeImportMetadata gives explicit fields top priority", () => {
  const merged = mergeImportMetadata({
    extracted: { title: "提取标题", authors: ["提取作者"], venue: "提取期刊", doi: "10.1000/extracted" },
    explicit: { title: "显式标题", authors: ["显式作者"], doi: "10.1000/explicit" },
    crossref: { title: "Crossref 标题", authors: ["Crossref 作者"], venue: "Crossref 期刊", year: 2024, doi: "10.1000/crossref" }
  });
  // 显式字段永远赢
  assert.equal(merged.title, "显式标题");
  assert.deepEqual(merged.authors, ["显式作者"]);
  assert.equal(merged.doi, "10.1000/explicit");
  // 显式没传的字段由 Crossref 补全
  assert.equal(merged.venue, "Crossref 期刊");
  assert.equal(merged.year, 2024);
});

test("mergeImportMetadata falls back to extracted values when no explicit or crossref", () => {
  const merged = mergeImportMetadata({
    extracted: { title: "提取标题", authors: ["提取作者"], doi: "10.1000/from-pdf", year: 2023 }
  });
  assert.equal(merged.title, "提取标题");
  assert.deepEqual(merged.authors, ["提取作者"]);
  assert.equal(merged.doi, "10.1000/from-pdf");
  assert.equal(merged.year, 2023);
});

test("mergeImportMetadata fills missing fields from crossref without overriding explicit ones", () => {
  const merged = mergeImportMetadata({
    extracted: { title: "提取标题", authors: [], year: 2023 },
    explicit: { title: "显式标题" },
    crossref: { title: "Crossref 标题", authors: ["Crossref 作者"], abstract: "Crossref 摘要", year: 2024, doi: "10.1000/crossref" }
  });
  // 显式字段不被 Crossref 覆盖
  assert.equal(merged.title, "显式标题");
  // 提取值缺失的字段由 Crossref 补全
  assert.deepEqual(merged.authors, ["Crossref 作者"]);
  assert.equal(merged.abstract, "Crossref 摘要");
  // doi 取 Crossref 返回的规范 DOI
  assert.equal(merged.doi, "10.1000/crossref");
});

// ---------- buildImportedPdfPaper：带 doi 时反查合并（mock resolveByDoi） ----------

function stubExtractors() {
  return {
    extractText: async () => "Abstract This is a fake paper text. Introduction ...",
    guessMetadata: (text) => ({ title: "规则提取标题", authors: ["规则作者"], year: 2022, venue: "", doi: "", abstract: "", keywords: [] }),
    extractAi: async () => null
  };
}

test("buildImportedPdfPaper calls resolveByDoi with normalized explicit doi and merges metadata", async () => {
  let calledWith = null;
  const resolveByDoi = async (doi) => {
    calledWith = doi;
    return {
      id: "crossref-x", source: "crossref", doi: "10.1000/crossref-doi", title: "Crossref 标题",
      authors: ["Crossref 作者"], year: 2024, venue: "Crossref 期刊", abstract: "Crossref 摘要",
      keywords: [], pdfUrl: "https://example.com/should-not-win.pdf"
    };
  };
  const paper = await buildImportedPdfPaper(Buffer.from("%PDF-fake"), {
    pdfName: "fallback-name.pdf",
    explicit: { doi: "https://doi.org/10.1000/crossref-doi" },
    pdfUrl: "/api/pdf/file/abc.pdf",
    resolveByDoi,
    ...stubExtractors()
  });
  // doi 入参被规范化后传给反查函数
  assert.equal(calledWith, "10.1000/crossref-doi");
  // 显式未传 title/authors → Crossref 反查值覆盖提取值
  assert.equal(paper.title, "Crossref 标题");
  assert.deepEqual(paper.authors, ["Crossref 作者"]);
  assert.equal(paper.venue, "Crossref 期刊");
  assert.equal(paper.abstract, "Crossref 摘要");
  // doi 存入记录（Crossref 返回的规范 DOI）
  assert.equal(paper.doi, "10.1000/crossref-doi");
  // 本地 PDF 不被 Crossref 的 pdfUrl 覆盖
  assert.equal(paper.pdfUrl, "/api/pdf/file/abc.pdf");
  assert.equal(paper.localPdf, true);
  assert.equal(paper.aiExtracted, false);
});

test("buildImportedPdfPaper lets explicit title/authors override extraction and crossref", async () => {
  const resolveByDoi = async () => ({
    doi: "10.1000/x", title: "Crossref 标题", authors: ["Crossref 作者"], venue: "Crossref 期刊", year: 2024
  });
  const paper = await buildImportedPdfPaper(Buffer.from("%PDF-fake"), {
    explicit: { title: "显式标题", authors: "Alice, Bob", doi: "10.1000/x" },
    pdfUrl: "/api/pdf/file/abc.pdf",
    resolveByDoi,
    ...stubExtractors()
  });
  assert.equal(paper.title, "显式标题");
  assert.deepEqual(paper.authors, ["Alice", "Bob"]);
  assert.equal(paper.venue, "Crossref 期刊"); // 显式没传的仍由 Crossref 补全
});

test("buildImportedPdfPaper skips crossref lookup when doi missing and tolerates resolver failure", async () => {
  let calls = 0;
  const resolveByDoi = async () => {
    calls += 1;
    throw new Error("network down");
  };
  const paper = await buildImportedPdfPaper(Buffer.from("%PDF-fake"), {
    pdfName: "some-paper.pdf",
    explicit: {},
    pdfUrl: "/api/pdf/file/abc.pdf",
    resolveByDoi,
    ...stubExtractors()
  });
  assert.equal(calls, 0); // 没有 doi 就不该反查
  assert.equal(paper.title, "规则提取标题");
  assert.ok(!paper.doi, "无 doi 时记录的 doi 应为空");

  // 反查失败（网络错误）不应阻断导入
  const paper2 = await buildImportedPdfPaper(Buffer.from("%PDF-fake"), {
    explicit: { doi: "10.1000/broken" },
    pdfUrl: "/api/pdf/file/abc.pdf",
    resolveByDoi,
    ...stubExtractors()
  });
  assert.equal(calls, 1);
  assert.equal(paper2.title, "规则提取标题");
  assert.equal(paper2.doi, "10.1000/broken"); // 显式 doi 仍存入记录
});

test("buildImportedPdfPaper triggers crossref lookup with extracted doi when explicit doi missing", async () => {
  let calledWith = null;
  const resolveByDoi = async (doi) => {
    calledWith = doi;
    return {
      doi: "10.1000/canonical-doi", title: "Crossref 标题",
      authors: ["Crossref 作者"], year: 2024, venue: "Crossref 期刊"
    };
  };
  // 无显式 doi：PDF 首页文本几乎都印有 DOI，提取到的 doi 也应触发反查
  const paper = await buildImportedPdfPaper(Buffer.from("%PDF-fake"), {
    explicit: {},
    pdfUrl: "/api/pdf/file/abc.pdf",
    resolveByDoi,
    extractText: async () => "First page text with doi 10.1000/extracted-doi printed on it",
    guessMetadata: () => ({ title: "", authors: [], year: null, venue: "", doi: "https://doi.org/10.1000/extracted-doi", abstract: "", keywords: [] }),
    extractAi: async () => null
  });
  // 提取到的 doi 被规范化（去 doi.org 前缀）后传给反查函数
  assert.equal(calledWith, "10.1000/extracted-doi");
  // merged.doi 取 Crossref 返回的规范值，而非提取值
  assert.equal(paper.doi, "10.1000/canonical-doi");
  // 反查结果补全了提取不到的字段
  assert.equal(paper.title, "Crossref 标题");
  assert.equal(paper.venue, "Crossref 期刊");
});

// ---------- downloadPdf：mock fetcher ----------

function fakeResponse({ body = Buffer.alloc(0), status = 200, statusText = "OK", contentType = "application/pdf", headers = {} } = {}) {
  const allHeaders = { "content-type": contentType, ...headers };
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    url: "https://example.com/final.pdf",
    headers: { get: (name) => allHeaders[String(name).toLowerCase()] ?? null },
    arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength)
  };
}

test("downloadPdf sends cookie, referer and browser UA, and accepts PDF bytes", async () => {
  let captured = null;
  const fetcher = async (url, init) => {
    captured = { url, init };
    return fakeResponse({ body: Buffer.from("%PDF-1.4 fake pdf bytes") });
  };
  const { buffer, finalUrl } = await downloadPdf("https://example.com/paper.pdf", {
    cookie: "sid=abc; auth=1",
    sourceUrl: "https://example.com/article",
    fetcher
  });
  assert.ok(buffer);
  assert.ok(isPdfBytes(buffer));
  assert.equal(finalUrl, "https://example.com/final.pdf");
  assert.equal(captured.init.headers.Cookie, "sid=abc; auth=1");
  assert.equal(captured.init.headers.Referer, "https://example.com/article");
  assert.match(captured.init.headers["User-Agent"], /Mozilla\/5\.0/);
  assert.equal(captured.init.redirect, "follow");
});

function isPdfBytes(buffer) {
  return buffer.subarray(0, 5).toString("latin1") === "%PDF-";
}

test("downloadPdf rejects HTML landing page with kind not-pdf", async () => {
  const fetcher = async () => fakeResponse({ body: Buffer.from("<html>请登录后下载</html>"), contentType: "text/html" });
  await assert.rejects(
    () => downloadPdf("https://example.com/landing", { fetcher }),
    (err) => err instanceof PdfImportError && err.kind === "not-pdf" && err.message.includes("不是可直接下载的 PDF")
  );
});

test("downloadPdf rejects http errors and oversized content", async () => {
  const fetcher403 = async () => fakeResponse({ status: 403, statusText: "Forbidden", contentType: "text/html", body: Buffer.from("denied") });
  await assert.rejects(() => downloadPdf("https://example.com/x", { fetcher: fetcher403 }), (err) => err.kind === "network");

  const bigBody = Buffer.alloc(11, 65); // 11MB 但声明 200MB
  const fetcherTooLarge = async () => fakeResponse({ body: bigBody, headers: { "content-length": String(MAX_PDF_BYTES + 1) } });
  await assert.rejects(() => downloadPdf("https://example.com/x", { fetcher: fetcherTooLarge }), (err) => err.kind === "too-large");

  await assert.rejects(() => downloadPdf("ftp://example.com/x", { fetcher: async () => fakeResponse() }), (err) => err.kind === "network");
});

// ---------- guessPdfNameFromUrl ----------

test("guessPdfNameFromUrl extracts .pdf basename only", () => {
  assert.equal(guessPdfNameFromUrl("https://a.com/x/y%20paper.pdf?token=1"), "y paper.pdf");
  assert.equal(guessPdfNameFromUrl("https://a.com/article/123"), "");
  assert.equal(guessPdfNameFromUrl("not a url"), "");
});

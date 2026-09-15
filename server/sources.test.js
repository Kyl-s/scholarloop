import test from "node:test";
import assert from "node:assert/strict";
import { mergePaperRecord, normalizeIeeeArticle, normalizeWosHit, redactSensitiveError, searchPapers } from "./sources.js";

test("IEEE response maps metadata and normalizes DOI", () => {
  const paper = normalizeIeeeArticle({
    article_number: "123",
    title: "A title",
    publication_year: "2024",
    authors: { authors: { author: [{ full_name: "Ada Lovelace" }] } },
    doi: "https://doi.org/10.1000/ABC.",
    publication_title: "IEEE Journal",
    author_terms: ["machine learning"]
  });
  assert.equal(paper.source, "ieee");
  assert.equal(paper.doi, "10.1000/ABC");
  assert.equal(paper.year, 2024);
  assert.deepEqual(paper.authors, ["Ada Lovelace"]);
  assert.deepEqual(paper.keywords, ["machine learning"]);
  assert.match(paper.url, /ieeexplore\.ieee\.org\/document\/123/);
  assert.equal(paper.pdfUrl, "");
});

test("IEEE stamp.jsp is not treated as a downloadable PDF", () => {
  const paper = normalizeIeeeArticle({
    article_number: "99",
    title: "Stamp",
    pdf_url: "https://ieeexplore.ieee.org/stamp/stamp.jsp?tp=&arnumber=99",
    html_url: "https://ieeexplore.ieee.org/document/99"
  });
  assert.equal(paper.pdfUrl, "");
  assert.match(paper.url, /ieeexplore\.ieee\.org\/document\/99/);
});

test("IEEE keeps a direct PDF link", () => {
  const paper = normalizeIeeeArticle({
    article_number: "99",
    title: "Direct",
    pdf_url: "https://ieeexplore.ieee.org/ielx7/99/99/099.pdf"
  });
  assert.match(paper.pdfUrl, /\.pdf$/);
});

test("merge keeps a later direct PDF instead of the first empty or landing-page url", () => {
  const first = normalizeIeeeArticle({
    article_number: "1",
    title: "Shared",
    doi: "10.1000/ABC",
    pdf_url: "https://ieeexplore.ieee.org/stamp/stamp.jsp?arnumber=1"
  });
  const second = {
    ...first,
    source: "arxiv",
    sourceLabel: "arXiv",
    pdfUrl: "https://arxiv.org/pdf/2301.00001.pdf",
    abstract: "longer abstract from arxiv that should win"
  };
  const merged = mergePaperRecord(first, second);
  assert.equal(merged.pdfUrl, "https://arxiv.org/pdf/2301.00001.pdf");
  assert.deepEqual(merged.sources.sort(), ["arxiv", "ieee"]);
  assert.match(merged.abstract, /arxiv/);
});

test("Web of Science Starter hit maps nested fields", () => {
  const paper = normalizeWosHit({
    uid: "WOS:1",
    title: { title: [{ value: "B title" }] },
    published: "2023-02-01",
    names: { authors: { author: [{ displayName: "Grace Hopper" }] } },
    source: { title: "Journal" },
    identifiers: [{ type: "doi", value: "10.1000/XYZ" }],
    links: [{ type: "record", url: "https://wos.example/1" }],
    citations: { count: 4 }
  });
  assert.equal(paper.source, "wos");
  assert.equal(paper.doi, "10.1000/XYZ");
  assert.equal(paper.year, 2023);
  assert.deepEqual(paper.authors, ["Grace Hopper"]);
  assert.equal(paper.venue, "Journal");
  assert.equal(paper.citations, 4);
  assert.equal(paper.url, "https://wos.example/1");
});

test("unconfigured IEEE/WoS sources return portal-aware status without network", async () => {
  const result = await searchPapers("test", {
    sources: ["ieee", "wos"],
    queries: ["test"],
    sourceCredentials: { ieee: {}, wos: {} }
  });
  assert.deepEqual(result.papers, []);
  assert.equal(result.sourceStatus.length, 2);
  assert.match(result.sourceStatus.find((item) => item.id === "ieee").error, /API Key/);
  assert.equal(result.sourceStatus.find((item) => item.id === "ieee").portal, "https://ieeexplore.ieee.org");
  assert.match(result.sourceStatus.find((item) => item.id === "wos").error, /API Key/);
  assert.equal(result.sourceStatus.find((item) => item.id === "wos").portal, "https://www.webofscience.com");
});

test("redacts configured and bearer API keys from source errors", () => {
  const key = "source-secret-key";
  const detail = redactSensitiveError(`upstream rejected ${key}; Bearer sk-client-secret-123456; apiKey=${key}`, [key]);
  assert.doesNotMatch(detail, /source-secret-key|sk-client-secret-123456/);
  assert.match(detail, /\[已隐藏\]/);
});

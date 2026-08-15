import test from "node:test";
import assert from "node:assert/strict";
import { fetchPdfWithOpenAccessFallback } from "./pdfResolve.js";

const pdf = Buffer.from("%PDF-1.7\nScholarLoop test\n%%EOF", "latin1");

test("falls back from a blocked publisher URL to the DOI-matched Europe PMC PDF", async () => {
  const calls = [];
  const fetcher = async (url) => {
    calls.push(String(url));
    if (String(url).includes("cell.com")) {
      return new Response("blocked", { status: 403, statusText: "Forbidden" });
    }
    if (String(url).includes("idconv/api/v1/articles")) {
      return Response.json({ records: [{ doi: "10.1016/j.cell.2017.05.024", pmcid: "PMC5520675", live: true }] });
    }
    if (String(url).includes("europepmc.org/api/getPdf")) {
      return new Response(pdf, { status: 200, headers: { "Content-Type": "application/pdf" } });
    }
    throw new Error(`unexpected URL: ${url}`);
  };

  const result = await fetchPdfWithOpenAccessFallback({
    url: "http://www.cell.com/article/S0092867417305846/pdf",
    doi: "https://doi.org/10.1016/j.cell.2017.05.024",
    fetcher
  });

  assert.equal(result.source, "europe-pmc");
  assert.equal(result.pmcid, "PMC5520675");
  assert.deepEqual(result.buffer, pdf);
  assert.equal(calls.length, 3);
  assert.match(calls[1], /ids=10\.1016%2Fj\.cell\.2017\.05\.024/i);
  assert.match(calls[2], /pmcid=PMC5520675/);
});

test("keeps a working publisher PDF as the preferred source", async () => {
  const calls = [];
  const fetcher = async (url) => {
    calls.push(String(url));
    return new Response(pdf, { status: 200, headers: { "Content-Type": "application/pdf" } });
  };

  const result = await fetchPdfWithOpenAccessFallback({
    url: "https://publisher.example/paper.pdf",
    doi: "10.1000/example",
    fetcher
  });

  assert.equal(result.source, "publisher");
  assert.equal(result.pmcid, null);
  assert.deepEqual(result.buffer, pdf);
  assert.deepEqual(calls, ["https://publisher.example/paper.pdf"]);
});

import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { searchPapers, sourceTransport, checkPaperSource, selectLanguageQueries } from "./sources.js";

// Only network I/O is mocked. Real adapters, routing, merging, filtering and status
// aggregation run here. Live provider/proxy behavior is outside fixture coverage.
const original = sourceTransport.fetch;
afterEach(() => { sourceTransport.fetch = original; });
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const search = (sources, extra = {}) => searchPapers("world models", { sources, queries: ["world models"], ...extra });

test("regression: valid zero results differ from malformed and business error responses", async () => {
  sourceTransport.fetch = async (url) => {
    if (url.includes("openalex")) return json({ results: [] });
    if (url.includes("pubmed")) return json({ error: "upstream error" });
    return json({ unexpected: [] });
  };
  const result = await search(["openalex", "pubmed", "crossref"]);
  assert.deepEqual(result.sourceStatus.map((s) => s.state), ["empty", "failed", "failed"]);
  assert.equal(result.sourceStatus[0].successfulQueries, 1);
  assert.equal(result.sourceStatus[1].errors[0].type, "invalid_response");
  assert.equal(result.sourceStatus[2].errors[0].type, "invalid_response");
});

test("regression: one successful query cannot conceal another failure", async () => {
  sourceTransport.fetch = async (url) => new URL(url).searchParams.get("search") === "world models" ? json({ results: [] }) : json({}, 403);
  const result = await search(["openalex"], { queries: ["world models", "latent dynamics"] });
  const status = result.sourceStatus[0];
  assert.equal(status.state, "partial");
  assert.equal(status.successfulQueries, 1);
  assert.equal(status.failedQueries, 1);
  assert.equal(status.attemptedQueries, 2);
  assert.equal(status.errors[0].type, "access_denied");
});

test("regression: missing or disabled credentials are not network failures", async () => {
  sourceTransport.fetch = async () => { throw new Error("must not request"); };
  const result = await search(["ieee", "wos"], { sourceCredentials: { wos: { enabled: false } } });
  assert.deepEqual(result.sourceStatus.map((s) => s.state), ["unconfigured", "disabled"]);
  assert.ok(result.sourceStatus.every((s) => s.attemptedQueries === 0));
});

test("regression: shared DOI is case-insensitive and counts preserve overlapping sources", async () => {
  sourceTransport.fetch = async (url) => url.includes("openalex")
    ? json({ results: [{ id: "W1", title: "World models", doi: "https://doi.org/10.1/ABC", publication_year: 2024 }] })
    : json({ message: { items: [{ DOI: "10.1/abc", title: ["World models"], issued: { "date-parts": [[2024]] } }] } });
  const result = await search(["openalex", "crossref"]);
  assert.equal(result.papers.length, 1);
  assert.deepEqual(result.papers[0].sources.sort(), ["crossref", "openalex"]);
  assert.deepEqual(result.sourceStatus.map((s) => s.displayedCount), [1, 1]);
});

test("regression: successful source filtered by year stays successful with zero displayed papers", async () => {
  sourceTransport.fetch = async () => json({ data: [{ paperId: "1", title: "World models", year: 1999 }] });
  const result = await search(["semanticscholar"], { fromYear: 2024 });
  assert.equal(result.papers.length, 0);
  assert.equal(result.sourceStatus[0].state, "empty");
  assert.equal(result.sourceStatus[0].uniqueCount, 1);
  assert.equal(result.sourceStatus[0].filteredCount, 0);
});

test("regression: CNKI cache isolates limits and does not retain response errors", async () => {
  let calls = 0;
  sourceTransport.fetch = async () => { calls++; return calls === 1 ? json({ code: 403 }) : json({ articleList: [] }); };
  const opts = { queries: ["缓存隔离验证"], limit: 5 };
  assert.equal((await search(["cnki"], opts)).sourceStatus[0].state, "failed");
  assert.equal((await search(["cnki"], opts)).sourceStatus[0].state, "empty");
  await search(["cnki"], opts);
  assert.equal(calls, 2);
  await search(["cnki"], { ...opts, limit: 100 });
  assert.equal(calls, 3);
});

test("regression: provider queue serializes simultaneous query requests", async () => {
  let active = 0;
  let maximum = 0;
  sourceTransport.fetch = async () => {
    active++;
    maximum = Math.max(maximum, active);
    await Promise.resolve();
    active--;
    return json({ results: [] });
  };
  await search(["openalex"], { queries: ["world models", "latent dynamics", "reinforcement learning"] });
  assert.equal(maximum, 1);
});

test("regression: connection check rejects HTTP 200 error envelope and redacts credentials", async () => {
  sourceTransport.fetch = async () => json({ error: "invalid key" });
  const result = await checkPaperSource("ieee", { apiKey: "fixture-key" });
  assert.equal(result.ok, false);
  assert.doesNotMatch(result.error, /fixture-key/);
});

test("regression: final six queries retain both languages", () => {
  const selected = selectLanguageQueries(["原始中文", "中文一", "中文二", "中文三", "中文四", "中文五", "world models"]);
  assert.equal(selected.length, 6);
  assert.ok(selected.includes("world models"));
  assert.equal(selected[0], "原始中文");
});

test("rate limit retry is bounded and reflected in execution counts", async () => {
  let calls = 0;
  sourceTransport.fetch = async () => {
    calls++;
    return calls === 1 ? new Response("", { status: 429, headers: { "retry-after": "0.001" } }) : json({ results: [] });
  };
  const result = await search(["openalex"]);
  assert.equal(calls, 2);
  assert.equal(result.sourceStatus[0].attempts, 2);
  assert.equal(result.sourceStatus[0].state, "empty");
});

test("non JSON response is a parsing failure rather than a successful empty source", async () => {
  sourceTransport.fetch = async () => new Response("<html>captcha</html>");
  const result = await search(["cnki"], { queries: ["解析失败验证"] });
  assert.equal(result.sourceStatus[0].state, "failed");
  assert.equal(result.sourceStatus[0].errors[0].type, "invalid_response");
});

test("exhausted search budget prevents subsequent provider requests", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1000 });
  let calls = 0;
  sourceTransport.fetch = async () => {
    calls++;
    t.mock.timers.setTime(62000);
    return json({ results: [] });
  };
  const result = await search(["openalex"], { queries: ["world models", "latent dynamics"] });
  assert.equal(calls, 1);
  assert.equal(result.sourceStatus[0].state, "partial");
  assert.equal(result.sourceStatus[0].errors[0].type, "timeout");
});

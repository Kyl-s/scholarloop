import test from "node:test";
import assert from "node:assert/strict";
import { reviewTranslatedLayout, validateLayoutReview } from "./pdfLayoutReview.js";

test("compares original and translated images and validates bounded findings", async () => {
  const source = { image: "data:image/png;base64,c291cmNl" };
  const translated = { image: "data:image/png;base64,dHJhbnNsYXRlZA==" };
  let request;
  const result = await reviewTranslatedLayout({ source, translated, page: 2, config: { baseUrl: "https://example.invalid/v1", apiKey: "fixture", model: "test" }, fetchImpl: async (url, init) => {
    request = JSON.parse(init.body);
    return Response.json({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ version: "layout-review-v1", page: 2, issues: [{ category: "overlap", description: "文字重叠", bbox: [0.1, 0.2, 0.9, 0.4] }] }) } }] });
  } });
  assert.deepEqual(request.messages[1].content.filter((v) => v.type === "image_url").map((v) => v.image_url.url), [source.image, translated.image]);
  assert.equal(result.issues[0].description, "文字重叠");
});

test("rejects unbounded or malformed model output rather than claiming a clean page", () => {
  assert.throws(() => validateLayoutReview({ version: "layout-review-v1", page: 3, issues: [] }, 2));
  assert.throws(() => validateLayoutReview({ version: "layout-review-v1", page: 2, issues: [{ category: "overlap", description: "重叠", bbox: [0, 0, 2, 1] }] }, 2));
  assert.throws(() => validateLayoutReview({ version: "layout-review-v1", page: 2, issues: [{ category: "unknown", description: "重叠", bbox: [0, 0, 1, 1] }] }, 2));
});

test("rejects failed and truncated requests", async () => {
  const base = { source: { image: "a" }, translated: { image: "b" }, page: 1, config: { baseUrl: "https://example.invalid", apiKey: "fixture", model: "test" } };
  await assert.rejects(reviewTranslatedLayout({ ...base, fetchImpl: async () => new Response("failure", { status: 503 }) }), /HTTP 503/);
  await assert.rejects(reviewTranslatedLayout({ ...base, fetchImpl: async () => Response.json({ choices: [{ finish_reason: "length", message: { content: "{}" } }] }) }), /截断/);
});

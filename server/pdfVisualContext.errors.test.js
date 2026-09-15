import assert from "node:assert/strict";
import test from "node:test";
import { requestPdfVisualContext } from "./pdfVisualContext.js";

function requestWithError(status, body) {
  return requestPdfVisualContext({
    page: 2,
    rendered: { textLayer: true, image: "data:image/png;base64,AA==", lines: [{ text: "Title" }] },
    config: { baseUrl: "https://model.example/v1", apiKey: "not-a-real-key", model: "vision-test" },
    fetchImpl: async () => ({ ok: false, status, async text() { return body; } })
  });
}

test("将不支持图片输入的上游错误转换为安全的可操作提示", async () => {
  await assert.rejects(
    requestWithError(400, JSON.stringify({ error: { message: "model does not support image_url input; secret-provider-detail" } })),
    (error) => {
      assert.equal(error.code, "VISION_UNSUPPORTED");
      assert.match(error.message, /不支持图片输入/);
      assert.doesNotMatch(error.message, /secret-provider-detail|image_url/);
      return true;
    }
  );
});

test("将视觉鉴权、图片过大和其他上游错误分类且不回显详情", async () => {
  const cases = [
    { status: 401, body: "invalid api key secret-value", code: "VISION_AUTH" },
    { status: 413, body: "request entity too large secret-value", code: "VISION_TOO_LARGE" },
    { status: 503, body: "provider internal detail secret-value", code: "VISION_UPSTREAM" }
  ];
  for (const item of cases) {
    await assert.rejects(requestWithError(item.status, item.body), (error) => {
      assert.equal(error.code, item.code);
      assert.doesNotMatch(error.message, /secret-value|provider internal detail|invalid api key/);
      return true;
    });
  }
});


function requestWithBody(body, { status = 200, jsonError = false } = {}) {
  return requestPdfVisualContext({
    page: 2,
    rendered: { textLayer: true, image: "data:image/png;base64,AA==", lines: [{ text: "Title" }] },
    config: { baseUrl: "https://model.example/v1", apiKey: "not-a-real-key", model: "vision-test" },
    fetchImpl: async () => ({ ok: true, status, async json() { if (jsonError) throw new Error("bad json"); return body; } })
  });
}

const validContext = { version: "page-context-v1", page: 2, textLayer: true, columns: 1, readingOrder: [0], regions: [{ kind: "title", order: 0, lineIndexes: [0], confidence: 1 }], notes: "" };

test("兼容对象 content、choice.text 和 output_text 的视觉响应", async () => {
  for (const body of [
    { choices: [{ message: { content: { type: "output_text", text: JSON.stringify(validContext) } } }] },
    { choices: [{ text: JSON.stringify(validContext) }] },
    { output_text: JSON.stringify(validContext) }
  ]) {
    const result = await requestWithBody(body);
    assert.equal(result.page, 2);
    assert.equal(result.regions[0].kind, "title");
  }
});

test("区分 200 错误信封、空响应、思考独占和非法 JSON", async () => {
  await assert.rejects(requestWithBody({ error: { message: "model expired" } }), (error) => error.code === "VISION_MODEL_UNAVAILABLE");
  await assert.rejects(requestWithBody({ choices: [] }), (error) => error.code === "VISION_EMPTY");
  await assert.rejects(requestWithBody({ choices: [{ message: { reasoning_content: "thinking only" } }] }), (error) => error.code === "VISION_REASONING_ONLY");
  await assert.rejects(requestWithBody({}, { jsonError: true }), (error) => error.code === "VISION_INVALID_JSON");
});

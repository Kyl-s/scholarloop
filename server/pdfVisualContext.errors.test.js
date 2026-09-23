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

test("推理字段旁有最终 JSON 时不再误判为思考独占", async () => {
  const result = await requestWithBody({
    choices: [{
      message: {
        reasoning_content: "先判断页面结构",
        output_text: JSON.stringify(validContext)
      }
    }]
  });
  assert.equal(result.page, 2);
});

test("视觉输出被长度截断时只重试一次，并关闭 DeepSeek 思考模式", async () => {
  let calls = 0;
  const bodies = [];
  const result = await requestPdfVisualContext({
    page: 2,
    rendered: { textLayer: true, image: "data:image/png;base64,AA==", lines: [{ text: "Title" }] },
    config: {
      baseUrl: "https://api.deepseek.com/v1",
      apiKey: "not-a-real-key",
      model: "deepseek-flash"
    },
    fetchImpl: async (_url, options) => {
      calls += 1;
      bodies.push(JSON.parse(options.body));
      if (calls === 1) {
        return {
          ok: true,
          status: 200,
          async json() {
            return {
              choices: [{
                finish_reason: "length",
                message: { reasoning_content: "页面较复杂，继续分析" }
              }]
            };
          }
        };
      }
      return {
        ok: true,
        status: 200,
        async json() {
          return { choices: [{ finish_reason: "stop", message: { content: JSON.stringify(validContext) } }] };
        }
      };
    }
  });

  assert.equal(result.page, 2);
  assert.equal(calls, 2);
  assert.equal(bodies[0].max_tokens, 4000);
  assert.equal(bodies[1].max_tokens, 8000);
  assert.deepEqual(bodies[0].thinking, { type: "disabled" });
  assert.deepEqual(bodies[1].thinking, { type: "disabled" });
});

test("DeepSeek 返回 reasoning-only 且没有 finish_reason 时也只重试一次", async () => {
  let calls = 0;
  const result = await requestPdfVisualContext({
    page: 2,
    rendered: { textLayer: true, image: "data:image/png;base64,AA==", lines: [{ text: "Title" }] },
    config: { baseUrl: "https://gateway.example/v1", apiKey: "not-a-real-key", model: "deepseek-v4-flash" },
    fetchImpl: async () => {
      calls += 1;
      return {
        ok: true,
        status: 200,
        async json() {
          return calls === 1
            ? { choices: [{ message: { reasoning_content: "只完成了分析" } }] }
            : { choices: [{ message: { content: JSON.stringify(validContext) } }] };
        }
      };
    }
  });
  assert.equal(result.page, 2);
  assert.equal(calls, 2);
});

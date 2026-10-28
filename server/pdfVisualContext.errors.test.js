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

function visualArgs(fetchImpl, extra = {}) {
  return {
    page: 2,
    rendered: { textLayer: true, image: "data:image/png;base64,AA==", lines: [{ text: "Title" }] },
    config: { baseUrl: "https://gateway.example/v1", apiKey: "not-a-real-key", model: "gpt-6-luna" },
    fetchImpl,
    ...extra
  };
}

const successResponse = () => ({ ok: true, status: 200, async json() {
  return { choices: [{ message: { content: JSON.stringify(validContext) } }] };
} });
const bodyResponse = (body) => ({ ok: true, status: 200, async json() { return body; } });
const httpResponse = (status) => ({ ok: false, status, async text() { return "upstream failure"; } });

test("非 DeepSeek 的原 reasoning-only 失败形态可恢复，且不添加模型专属参数", async () => {
  const bodies = [];
  const result = await requestPdfVisualContext(visualArgs(async (_url, options) => {
    bodies.push(JSON.parse(options.body));
    return bodies.length === 1
      ? bodyResponse({ choices: [{ message: { reasoning_content: "只完成了分析" } }] })
      : successResponse();
  }));
  assert.equal(result.page, 2);
  assert.equal(bodies.length, 2);
  assert.deepEqual(bodies.map((body) => body.max_tokens), [4000, 8000]);
  assert.ok(bodies.every((body) => !("thinking" in body)));
});

test("截断、网络、超时和暂时上游错误均可在第二次恢复", async (t) => {
  const failures = {
    truncated: () => bodyResponse({ choices: [{ finish_reason: "length", message: { content: '{"version":' } }] }),
    network: () => { throw new TypeError("fetch failed secret"); },
    timeout: () => { throw new DOMException("timed out secret", "TimeoutError"); },
    bodyNetwork: () => ({ ok: true, async json() { throw new TypeError("terminated secret"); } }),
    bodyTimeout: () => ({ ok: true, async json() { throw new DOMException("timed out", "TimeoutError"); } }),
    invalidJson: () => bodyResponse({ choices: [{ message: { content: "not json" } }] }),
    invalidSchema: () => bodyResponse({ output_text: "{}" }),
    http408: () => httpResponse(408),
    http429: () => httpResponse(429),
    http503: () => httpResponse(503)
  };
  for (const [name, failure] of Object.entries(failures)) await t.test(name, async () => {
    let calls = 0;
    const result = await requestPdfVisualContext(visualArgs(async () => ++calls === 1 ? failure() : successResponse()));
    assert.equal(result.page, 2);
    assert.equal(calls, 2);
  });
});

test("连续或混合可恢复失败总尝试数为二，最终错误保持诚实", async (t) => {
  const cases = [
    [() => bodyResponse({ choices: [{ message: { reasoning_content: "thinking" } }] }), "VISION_REASONING_ONLY"],
    [() => { throw new TypeError("fetch failed secret"); }, "VISION_NETWORK"],
    [() => { throw new DOMException("timeout secret", "TimeoutError"); }, "VISION_TIMEOUT"],
    [() => bodyResponse({ choices: [{ finish_reason: "length", message: { content: "{" } }] }), "VISION_OUTPUT_TRUNCATED"],
    [() => httpResponse(503), "VISION_UPSTREAM"]
  ];
  for (const [failure, code] of cases) await t.test(code, async () => {
    let calls = 0;
    await assert.rejects(requestPdfVisualContext(visualArgs(async () => { calls++; return failure(); })), (error) => {
      assert.equal(error.code, code);
      assert.equal(error.retryable, false, "耗尽请求重试后不应触发页面层重试");
      assert.doesNotMatch(error.message, /secret/);
      return true;
    });
    assert.equal(calls, 2);
  });
  let calls = 0;
  await assert.rejects(requestPdfVisualContext(visualArgs(async () => {
    calls++;
    if (calls === 1) throw new TypeError("fetch failed");
    return bodyResponse({ choices: [{ message: { reasoning_content: "thinking" } }] });
  })), { code: "VISION_REASONING_ONLY" });
  assert.equal(calls, 2);
});

test("永久错误不重试，包括明确不支持图片和鉴权失败", async () => {
  for (const [status, detail, code] of [
    [400, "model does not support image_url", "VISION_UNSUPPORTED"],
    [401, "invalid api key", "VISION_AUTH"],
    [403, "forbidden", "VISION_AUTH"],
    [404, "model not found", "VISION_MODEL_UNAVAILABLE"],
    [413, "request too large", "VISION_TOO_LARGE"],
    [400, "invalid parameter", "VISION_UPSTREAM"]
  ]) {
    let calls = 0;
    await assert.rejects(requestPdfVisualContext(visualArgs(async () => {
      calls++;
      return { ok: false, status, async text() { return detail; } };
    })), (error) => error.code === code && error.retryable === false);
    assert.equal(calls, 1);
  }
});

test("请求层耗尽预算后，页面层按 retryable 判断不会叠加重试", async () => {
  let requests = 0;
  let preparations = 0;
  async function prepare(retryCount = 0) {
    preparations++;
    try {
      return await requestPdfVisualContext(visualArgs(async () => {
        requests++;
        throw new TypeError("fetch failed");
      }));
    } catch (error) {
      if (error.retryable === true && retryCount < 1) return prepare(retryCount + 1);
      throw error;
    }
  }
  await assert.rejects(prepare(), { code: "VISION_NETWORK", retryable: false });
  assert.equal(requests, 2);
  assert.equal(preparations, 1);
});

test("预取消、请求中取消、读取响应时取消和独立 AbortError 均不重试", async () => {
  for (const when of ["before", "fetch", "body", "abortError"]) {
    const controller = new AbortController();
    let calls = 0;
    if (when === "before") controller.abort();
    await assert.rejects(requestPdfVisualContext(visualArgs(async () => {
      calls++;
      if (when === "abortError") throw new DOMException("aborted", "AbortError");
      if (when === "fetch") {
        controller.abort();
        throw new TypeError("fetch failed");
      }
      return { ok: true, async json() {
        controller.abort();
        throw controller.signal.reason;
      } };
    }, { signal: controller.signal })), { name: "AbortError" });
    assert.equal(calls, when === "before" ? 0 : 1);
  }
});

test("重试中取消立即终止，重试返回永久错误不掩盖为首轮失败", async () => {
  const controller = new AbortController();
  let calls = 0;
  await assert.rejects(requestPdfVisualContext(visualArgs(async () => {
    calls++;
    if (calls === 1) throw new TypeError("fetch failed");
    controller.abort();
    throw controller.signal.reason;
  }, { signal: controller.signal })), { name: "AbortError" });
  assert.equal(calls, 2);

  calls = 0;
  await assert.rejects(requestPdfVisualContext(visualArgs(async () => {
    calls++;
    if (calls === 1) return bodyResponse({ choices: [{ message: { reasoning_content: "thinking" } }] });
    return { ok: false, status: 400, async text() { return "model does not support image_url"; } };
  })), (error) => error.code === "VISION_UNSUPPORTED" && !error.retryable);
  assert.equal(calls, 2);
});

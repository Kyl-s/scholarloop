import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test, { mock } from "node:test";

// Run module mocks in an isolated child so the regular test command needs no
// experimental flags. Never consult the real credential vault or network.
if (!process.env.SCHOLARLOOP_VISUAL_OAUTH_TEST_CHILD) {
  test("视觉默认传输的 OAuth/API-key 隔离回归", () => {
    const child = spawnSync(process.execPath, ["--experimental-test-module-mocks", "--test", fileURLToPath(import.meta.url)], {
      env: { ...process.env, SCHOLARLOOP_VISUAL_OAUTH_TEST_CHILD: "1" },
      encoding: "utf8",
      timeout: 30000
    });
    assert.equal(child.status, 0, `${child.stdout}\n${child.stderr}`);
  });
} else {
  let oauthHandler;
  let tokenReads = 0;
  mock.module("./chatgptAuth.js", { namedExports: {
    getChatGptAccessToken: async () => { tokenReads++; return "fake-oauth-secret"; }
  } });
  mock.module("./proxy.js", { namedExports: {
    getProxyUrl: () => "http://fake-proxy.invalid",
    fetchWithProxy: (...args) => oauthHandler(...args)
  } });
  const { requestPdfVisualContext } = await import("./pdfVisualContext.js");
  const context = { version: "page-context-v1", page: 1, textLayer: true, columns: 1, readingOrder: [0], regions: [], notes: "" };
  const args = (extra = {}) => ({
    page: 1,
    config: { baseUrl: "scholarloop-chatgpt://local", apiKey: "fake-placeholder-secret", model: "gpt-6-luna" },
    rendered: { textLayer: true, image: "data:image/png;base64,AA==", lines: [{ text: "Title" }] },
    ...extra
  });
  const completion = () => Response.json({ choices: [{ message: { content: JSON.stringify(context) } }] });
  const stream = () => new Response(`data: ${JSON.stringify({ type: "response.completed", response: {
    status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(context) }] }]
  } })}\n\n`, { headers: { "Content-Type": "text/event-stream" } });

  test("默认内部协议进入真实 adapter，转换图片并仅向固定上游发送 OAuth 凭据", async () => {
    const noDirect = mock.method(globalThis, "fetch", async () => { throw new Error("unexpected direct network"); });
    let calls = 0;
    oauthHandler = async (url, options, proxy) => {
      calls++;
      assert.equal(url, "https://api.openai.com/v1/responses");
      assert.equal(proxy, "http://fake-proxy.invalid");
      assert.equal(options.headers.Authorization, "Bearer fake-oauth-secret");
      assert.equal(options.redirect, "error");
      assert.doesNotMatch(JSON.stringify(options), /fake-placeholder-secret/);
      const body = JSON.parse(options.body);
      assert.equal(body.model, "gpt-6-luna");
      assert.equal(body.input[0].role, "developer");
      assert.equal(body.input[1].content[0].type, "input_text");
      assert.deepEqual(body.input[1].content[1], { type: "input_image", image_url: "data:image/png;base64,AA==", detail: "auto" });
      return stream();
    };
    try {
      const result = await requestPdfVisualContext(args());
      assert.deepEqual(result, context);
      assert.doesNotMatch(JSON.stringify(result), /fake-.*secret/);
      assert.equal(calls, 1);
      assert.equal(noDirect.mock.callCount(), 0);
    } finally { noDirect.mock.restore(); }
  });

  test("取消穿过默认 adapter 到上游且不重试", async () => {
    const controller = new AbortController();
    let calls = 0;
    oauthHandler = async (_url, options) => {
      calls++;
      assert.equal(options.signal.aborted, false);
      controller.abort();
      assert.equal(options.signal.aborted, true);
      throw options.signal.reason;
    };
    await assert.rejects(requestPdfVisualContext(args({ signal: controller.signal })), { name: "AbortError" });
    assert.equal(calls, 1);
  });

  test("OAuth 鉴权错误不回显上游凭据且不重试", async () => {
    let calls = 0;
    oauthHandler = async () => { calls++; return Response.json({ error: { message: "unauthorized fake-oauth-secret fake-placeholder-secret" } }, { status: 401 }); };
    await assert.rejects(requestPdfVisualContext(args()), (error) => {
      assert.equal(error.code, "VISION_AUTH");
      assert.equal(error.retryable, false);
      assert.doesNotMatch(error.message, /fake-.*secret/);
      return true;
    });
    assert.equal(calls, 1);
  });

  test("API-key 默认直通与显式 fetch 注入保持原行为，不读取 OAuth", async () => {
    const before = tokenReads;
    const direct = mock.method(globalThis, "fetch", async (url, options) => {
      assert.equal(url, "https://ordinary.invalid/v1/chat/completions");
      assert.equal(options.headers.Authorization, "Bearer fake-api-key");
      assert.equal(JSON.parse(options.body).messages[1].content[1].type, "image_url");
      return completion();
    });
    try {
      await requestPdfVisualContext(args({ config: { baseUrl: "https://ordinary.invalid/v1", apiKey: "fake-api-key", model: "vision-test" } }));
      let injected = 0;
      await requestPdfVisualContext(args({ fetchImpl: async (url) => {
        injected++;
        assert.equal(url, "scholarloop-chatgpt://local/chat/completions");
        return completion();
      } }));
      assert.equal(injected, 1);
      assert.equal(direct.mock.callCount(), 1);
      assert.equal(tokenReads, before);
    } finally { direct.mock.restore(); }
  });
}

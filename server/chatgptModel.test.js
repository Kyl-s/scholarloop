import test from "node:test";
import assert from "node:assert/strict";
import { createChatGptModelFetch, toChatGptResponsesBody, readChatGptStream, CHATGPT_BASE_URL } from "./chatgptModel.js";

const frame = (value) => `data: ${JSON.stringify(value)}\r\n\r\n`;
function stream(events, size = 7) {
  const bytes = new TextEncoder().encode(events.map(frame).join(""));
  return new Response(new ReadableStream({ start(controller) {
    for (let i = 0; i < bytes.length; i += size) controller.enqueue(bytes.slice(i, i + size));
    controller.close();
  } }));
}
const completed = (output = []) => ({ type: "response.completed", response: { id: "resp_test", status: "completed", model: "test", output, usage: { input_tokens: 8, output_tokens: 4, total_tokens: 12, input_tokens_details: { cached_tokens: 3 } } } });

test("converts images, system instructions and a full namespaced function round trip", () => {
  const result = toChatGptResponsesBody({ model: "test", temperature: 0.4, max_tokens: 99, max_output_tokens: 99, metadata: { secret: true }, messages: [
    { role: "system", content: "Research" },
    { role: "user", content: [{ type: "text", text: "Read" }, { type: "image_url", image_url: { url: "data:image/png;base64,AAAA", detail: "high" } }] },
    { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "lookup", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "call_1", content: "found" }
  ], tools: [{ type: "function", function: { name: "lookup", parameters: { type: "object" } } }], tool_choice: "auto", response_format: { type: "json_object" } });
  assert.equal(result.input[0].role, "developer");
  assert.equal(result.input[1].content[1].type, "input_image");
  assert.equal(result.input[1].content[1].detail, "high");
  assert.deepEqual(result.input[2], { type: "function_call", call_id: "call_1", namespace: "scholarloop", name: "lookup", arguments: "{}" });
  assert.deepEqual(result.input[3], { type: "function_call_output", call_id: "call_1", output: "found" });
  assert.equal(result.tools[0].type, "namespace");
  assert.equal(result.tools[0].tools[0].strict, false);
  assert.equal(result.stream, true);
  assert.equal(result.store, false);
  for (const key of ["temperature", "max_tokens", "max_output_tokens", "metadata"]) assert.equal(result[key], undefined);
});

test("buffers UTF-8 SSE chunks and exposes final content, usage and tool calls", async () => {
  const value = await readChatGptStream(stream([{ type: "response.output_text.delta", delta: "partial" }, completed([
    { type: "message", content: [{ type: "output_text", text: "论文结果" }] },
    { type: "function_call", namespace: "scholarloop", name: "lookup", call_id: "call_1", arguments: "{}" }
  ])], 1));
  assert.equal(value.choices[0].message.content, "论文结果");
  assert.equal(value.choices[0].message.tool_calls[0].function.name, "lookup");
  assert.equal(value.choices[0].finish_reason, "tool_calls");
  assert.equal(value.usage.prompt_tokens_details.cached_tokens, 3);
  const continuation = toChatGptResponsesBody({ model: "test", messages: [value.choices[0].message, { role: "tool", tool_call_id: "call_1", content: "found" }] });
  assert.deepEqual(continuation.input.slice(0, -1), value.choices[0].message.chatgpt_response_output);
  assert.equal(continuation.input.at(-1).call_id, "call_1");
});

test("requires response.completed and rejects failed, incomplete, malformed and interrupted streams", async () => {
  await assert.rejects(readChatGptStream(stream([{ type: "response.output_text.delta", delta: "partial" }])), /response.completed/);
  for (const type of ["response.failed", "response.incomplete", "error"]) {
    await assert.rejects(readChatGptStream(stream([{ type, response: { error: { code: "usage_limit" } } }])), /usage_limit/);
  }
  await assert.rejects(readChatGptStream(new Response("data: malformed\n\n")), /JSON/);
  await assert.rejects(readChatGptStream(new Response(new ReadableStream({ start(c) { c.error(new Error("disconnected")); } }))), /disconnected/);
});

test("API-key providers pass through without reading OAuth credentials", async () => {
  const options = { headers: { Authorization: "Bearer ordinary-key" } };
  let called = false;
  const modelFetch = createChatGptModelFetch({ getAccessToken: () => { throw new Error("must not read"); }, ordinaryFetch: (url, opts) => {
    called = true; assert.equal(url, "https://model.example/chat/completions"); assert.equal(opts, options); return Response.json({ ok: true });
  } });
  assert.equal((await (await modelFetch("https://model.example/chat/completions", options)).json()).ok, true);
  assert.equal(called, true);
});

test("OAuth uses only fixed public endpoints, token and proxy with no retries", async () => {
  const controller = new AbortController();
  const requests = [];
  const modelFetch = createChatGptModelFetch({ getAccessToken: async () => "test-oauth-token", proxyUrl: () => "http://local-proxy", oauthFetch: async (...args) => {
    requests.push(args); return stream([completed([{ type: "message", content: [{ type: "output_text", text: "OK" }] }])]);
  } });
  const response = await modelFetch(`${CHATGPT_BASE_URL}/chat/completions`, { method: "POST", body: JSON.stringify({ model: "test", messages: [{ role: "user", content: "hi" }] }), headers: { Authorization: "Bearer untrusted", "x-secret": "must-not-forward" }, signal: controller.signal });
  assert.equal((await response.json()).choices[0].message.content, "OK");
  assert.equal(requests.length, 1);
  assert.equal(requests[0][0], "https://api.openai.com/v1/responses");
  assert.equal(requests[0][1].headers.Authorization, "Bearer test-oauth-token");
  assert.equal(requests[0][1].headers["x-secret"], undefined);
  assert.equal(requests[0][1].signal, controller.signal);
  assert.equal(requests[0][1].redirect, "error");
  assert.equal(requests[0][2], "http://local-proxy");
  await assert.rejects(modelFetch(`${CHATGPT_BASE_URL}/../../other`), /路径/);
});

test("model picker uses visible slugs in server order; HTTP errors retain status", async () => {
  const modelFetch = createChatGptModelFetch({ getAccessToken: async () => "fake", proxyUrl: () => null, oauthFetch: async () => Response.json({ models: [
    { slug: "b", display_name: "B", visibility: "list" }, { slug: "hidden", visibility: "hidden" }, { slug: "a", visibility: "list" }
  ] }) });
  const data = await (await modelFetch(`${CHATGPT_BASE_URL}/models`)).json();
  assert.deepEqual(data.data.map((m) => m.id), ["b", "a"]);
  let calls = 0;
  const denied = createChatGptModelFetch({ getAccessToken: async () => "fake", proxyUrl: () => null, oauthFetch: async () => { calls++; return Response.json({ error: { message: "expired" } }, { status: 401 }); } });
  assert.equal((await denied(`${CHATGPT_BASE_URL}/models`)).status, 401);
  assert.equal(calls, 1);
});


test("model refresh requests a fresh account catalog and includes new GPT-6 and GPT-6.1 slugs without a hardcoded list", async () => {
  let refresh = 0;
  const modelFetch = createChatGptModelFetch({ getAccessToken: async () => "fake", proxyUrl: () => null, oauthFetch: async (url, options) => {
    assert.equal(url, "https://api.openai.com/v1/models");
    assert.equal(options.headers["Cache-Control"], "no-cache");
    assert.equal(options.cache, "no-store");
    refresh++;
    return Response.json({ models: refresh === 1 ? [
      { slug: "gpt-6-astra", display_name: "GPT-6-Astra", visibility: "list" }
    ] : [
      { slug: "gpt-6.1-sol", display_name: "GPT-6.1-Sol", visibility: "list" },
      { slug: "gpt-6-sol", display_name: "GPT-6-Sol", visibility: "list" },
      { slug: "gpt-6-luna", visibility: "list" },
      { slug: "gpt-6-astra", visibility: "list" },
      { slug: "gpt-reserve", visibility: "hide" }
    ] });
  } });
  assert.deepEqual((await (await modelFetch(CHATGPT_BASE_URL + "/models")).json()).data.map(m => m.id), ["gpt-6-astra"]);
  const catalog = await (await modelFetch(CHATGPT_BASE_URL + "/models")).json();
  assert.deepEqual(catalog.data.map(m => m.id), ["gpt-6.1-sol", "gpt-6-sol", "gpt-6-luna", "gpt-6-astra"]);
  assert.equal(catalog.data[0].display_name, "GPT-6.1-Sol");
  assert.equal(catalog.data[2].display_name, "gpt-6-luna");
  assert.equal(refresh, 2);
});

test("an account catalog does not imply access to newer models absent from its response", async () => {
  const modelFetch = createChatGptModelFetch({ getAccessToken: async () => "fake", proxyUrl: () => null, oauthFetch: async () => Response.json({ models: [
    { slug: "gpt-6-astra", visibility: "list" },
    { slug: "gpt-5.6-sol", visibility: "list" }
  ] }) });
  const catalog = await (await modelFetch(CHATGPT_BASE_URL + "/models")).json();
  assert.deepEqual(catalog.data.map(m => m.id), ["gpt-6-astra", "gpt-5.6-sol"]);
});


test("recovers Luna text from completed output items when the final snapshot is empty or omitted", async () => {
  const item = { id: "msg_test", type: "message", status: "completed", role: "assistant", content: [{ type: "output_text", text: "你好" }] };
  for (const omit of [false, true]) {
    const final = completed();
    if (omit) delete final.response.output;
    const result = await readChatGptStream(stream([
      { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "你好" },
      { type: "response.output_text.done", output_index: 0, content_index: 0, text: "你好" },
      { type: "response.output_item.done", output_index: 0, item }, final
    ], 1));
    assert.equal(result.choices[0].message.content, "你好");
    assert.equal(result.usage.total_tokens, 12);
  }
});

test("recovers ordered reasoning and function calls for the next Agent tool round", async () => {
  const reasoning = { id: "reason_test", type: "reasoning", encrypted_content: "fake-encrypted-reasoning", summary: [] };
  const tool = { id: "fc_test", type: "function_call", status: "completed", namespace: "scholarloop", name: "lookup", call_id: "call_test", arguments: '{"query":"test"}' };
  const result = await readChatGptStream(stream([
    { type: "response.output_item.done", output_index: 1, item: tool },
    { type: "response.output_item.done", output_index: 0, item: reasoning }, completed()
  ]));
  const message = result.choices[0].message;
  assert.equal(result.choices[0].finish_reason, "tool_calls");
  assert.equal(message.tool_calls[0].function.arguments, tool.arguments);
  const next = toChatGptResponsesBody({ model: "test", messages: [message, { role: "tool", tool_call_id: "call_test", content: "found" }] });
  assert.deepEqual(next.input, [reasoning, tool, { type: "function_call_output", call_id: "call_test", output: "found" }]);
});

test("prefers the final output snapshot without duplicating streamed text", async () => {
  const item = { type: "message", content: [{ type: "output_text", text: "你好" }] };
  const result = await readChatGptStream(stream([{ type: "response.output_item.done", output_index: 0, item }, completed([item])]));
  assert.equal(result.choices[0].message.content, "你好");
});

test("completed output items do not turn a failed or interrupted stream into success", async () => {
  const item = { type: "message", content: [{ type: "output_text", text: "partial" }] };
  const done = { type: "response.output_item.done", output_index: 0, item };
  await assert.rejects(readChatGptStream(stream([done])), /response.completed/);
  for (const type of ["response.failed", "response.incomplete"]) {
    await assert.rejects(readChatGptStream(stream([done, { type, response: { error: { code: "usage_limit" } } }])), /usage_limit/);
  }
  await assert.rejects(readChatGptStream(stream([completed()])), /没有返回文本或工具调用/);
});

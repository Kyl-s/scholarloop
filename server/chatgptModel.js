import { getChatGptAccessToken } from "./chatgptAuth.js";
import { fetchWithProxy, getProxyUrl } from "./proxy.js";
import { withOpenCodeSessionHeader } from "./opencodeSession.js";

export const CHATGPT_BASE_URL = "scholarloop-chatgpt://local";
const API = "https://api.openai.com/v1";
const TOOL_NAMESPACE = "scholarloop";

export function isChatGptModelUrl(url) {
  return String(url) === CHATGPT_BASE_URL || String(url).startsWith(`${CHATGPT_BASE_URL}/`);
}

function contentParts(content, role) {
  if (typeof content === "string") return content;
  return (Array.isArray(content) ? content : []).map((part) => {
    if (part.type === "image_url") {
      return { type: "input_image", image_url: part.image_url?.url || part.image_url, detail: part.image_url?.detail || "auto" };
    }
    if (part.type === "text" || typeof part === "string") {
      return { type: role === "assistant" ? "output_text" : "input_text", text: typeof part === "string" ? part : part.text };
    }
    throw new Error(`ChatGPT 登录暂不支持消息内容类型：${part?.type || "unknown"}`);
  });
}

export function toChatGptResponsesBody(body) {
  const input = [];
  for (const message of body.messages || []) {
    // Keep encrypted reasoning and exact tool items in the server's current agent loop.
    if (message.role === "assistant" && Array.isArray(message.chatgpt_response_output)) {
      input.push(...message.chatgpt_response_output);
      continue;
    }
    if (message.role === "tool") {
      input.push({ type: "function_call_output", call_id: message.tool_call_id, output: typeof message.content === "string" ? message.content : JSON.stringify(message.content ?? "") });
      continue;
    }
    const role = message.role === "system" ? "developer" : message.role;
    if (message.content != null && message.content !== "") {
      input.push({ role, content: contentParts(message.content, role) });
    }
    for (const call of message.tool_calls || []) {
      input.push({ type: "function_call", call_id: call.id, namespace: TOOL_NAMESPACE, name: call.function.name, arguments: call.function.arguments });
    }
  }
  // ChatGPT plan requests accept a narrower parameter set than API-key requests.
  const result = { model: body.model, input, stream: true, store: false, include: ["reasoning.encrypted_content"] };
  if (body.reasoning_effort) result.reasoning = { effort: body.reasoning_effort };
  if (body.response_format?.type === "json_object") result.text = { format: { type: "json_object" } };
  if (body.response_format?.type === "json_schema") result.text = { format: { type: "json_schema", ...body.response_format.json_schema } };
  if (body.tools?.length) {
    result.tools = [{ type: "namespace", name: TOOL_NAMESPACE, description: "ScholarLoop research library, notes and learning tools.", tools: body.tools.map((tool) => {
      if (tool.type !== "function" || !tool.function?.name) throw new Error("ChatGPT 登录仅支持 ScholarLoop 函数工具");
      return { type: "function", ...tool.function, strict: tool.function.strict ?? false };
    }) }];
    if (typeof body.tool_choice === "string") result.tool_choice = body.tool_choice;
    else if (body.tool_choice?.function?.name) result.tool_choice = { type: "function", namespace: TOOL_NAMESPACE, name: body.tool_choice.function.name };
    if (typeof body.parallel_tool_calls === "boolean") result.parallel_tool_calls = body.parallel_tool_calls;
  }
  return result;
}

function completionJson(response) {
  const message = { role: "assistant", content: "" };
  const calls = [];
  for (const item of response.output || []) {
    if (item.type === "message") {
      for (const part of item.content || []) {
        if (part.type === "output_text") message.content += part.text || "";
        if (part.type === "refusal") message.content += part.refusal || "";
      }
    } else if (item.type === "function_call") {
      if (item.namespace && item.namespace !== TOOL_NAMESPACE) throw new Error("ChatGPT 返回了未知工具命名空间");
      calls.push({ id: item.call_id, type: "function", function: { name: item.name, arguments: item.arguments } });
    }
  }
  if (calls.length) {
    message.tool_calls = calls;
    message.chatgpt_response_output = response.output;
  }
  const usage = response.usage;
  return {
    id: response.id, object: "chat.completion", model: response.model,
    choices: [{ index: 0, message, finish_reason: calls.length ? "tool_calls" : "stop" }],
    ...(usage ? { usage: {
      prompt_tokens: usage.input_tokens, completion_tokens: usage.output_tokens, total_tokens: usage.total_tokens,
      prompt_tokens_details: usage.input_tokens_details, completion_tokens_details: usage.output_tokens_details
    } } : {})
  };
}

export async function readChatGptStream(response, { signal } = {}) {
  if (!response.body) throw new Error("ChatGPT 未返回响应流");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let completed = null;
  const completedItems = new Map();
  function event(frame) {
    const data = frame.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
    if (!data || data === "[DONE]") return;
    let value;
    try { value = JSON.parse(data); } catch {
      throw Object.assign(new Error("ChatGPT 响应流包含无效 JSON"), { code: "CHATGPT_STREAM_INVALID_JSON" });
    }
    if (["response.failed", "response.incomplete", "error"].includes(value.type)) {
      const detail = value.response?.error || value.error || value.response?.incomplete_details || value;
      if (value.type === "response.incomplete") {
        const truncated = detail.reason === "max_output_tokens";
        throw Object.assign(new Error(`ChatGPT 请求未完成：${truncated ? "输出被截断" : "响应未完成"}`), {
          code: truncated ? "CHATGPT_OUTPUT_TRUNCATED" : "CHATGPT_RESPONSE_INCOMPLETE"
        });
      }
      const statuses = {
        invalid_api_key: 401, authentication_error: 401, permission_denied: 403,
        model_not_found: 404, rate_limit_exceeded: 429, insufficient_quota: 429, server_error: 500
      };
      const status = Object.hasOwn(statuses, detail.code) ? statuses[detail.code] : 0;
      throw Object.assign(new Error("ChatGPT 请求未完成：上游请求失败"), {
        code: "CHATGPT_RESPONSE_FAILED", ...(status ? { status } : {})
      });
    }
    if (value.type === "response.output_item.done") {
      if (!Number.isInteger(value.output_index) || value.output_index < 0 || !value.item?.type) throw new Error("ChatGPT 返回了无效输出项");
      completedItems.set(value.output_index, value.item);
    }
    if (value.type === "response.completed") {
      if (!value.response || typeof value.response !== "object" || Array.isArray(value.response) || (value.response.status && value.response.status !== "completed")) throw new Error("ChatGPT 返回了无效完成状态");
      completed = value.response;
    }
  }
  let onAbort;
  let cancelled = false;
  function cancelReader() {
    if (cancelled) return;
    cancelled = true;
    // Do not let a slow upstream cancellation delay completion or abort.
    try { Promise.resolve(reader.cancel()).catch(() => {}); } catch { /* already closed */ }
  }
  try {
    signal?.throwIfAborted();
    const aborted = signal ? new Promise((_, reject) => {
      onAbort = () => {
        reject(signal.reason ?? new DOMException("The operation was aborted", "AbortError"));
        cancelReader();
      };
      signal.addEventListener("abort", onAbort, { once: true });
    }) : null;
    while (!completed) {
      signal?.throwIfAborted();
      const { value, done } = await (aborted ? Promise.race([reader.read(), aborted]) : reader.read());
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      let separator;
      while ((separator = /\r?\n\r?\n/.exec(buffer))) {
        event(buffer.slice(0, separator.index));
        buffer = buffer.slice(separator.index + separator[0].length);
        if (completed) break;
      }
      if (completed) break;
      if (done) { if (buffer.trim()) event(buffer); break; }
    }
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
    cancelReader();
    reader.releaseLock();
  }
  if (!completed) throw Object.assign(new Error("ChatGPT 响应流中断，未收到 response.completed"), { code: "CHATGPT_STREAM_INTERRUPTED" });
  // Some live plan responses carry completed items only in the preceding SSE events.
  // Prefer the final snapshot when present; never concatenate it with those items.
  const output = completed.output?.length ? completed.output
    : [...completedItems.entries()].sort(([left], [right]) => left - right).map(([, item]) => item);
  const result = completionJson({ ...completed, output });
  if (!result.choices[0].message.content.trim() && !result.choices[0].message.tool_calls?.length) {
    throw Object.assign(new Error("ChatGPT 已完成请求，但没有返回文本或工具调用"), { code: "CHATGPT_EMPTY_OUTPUT" });
  }
  return result;
}

/** Only the internal marker activates OAuth; ordinary providers retain their fetch behavior. */
export function createChatGptModelFetch({ getAccessToken = getChatGptAccessToken, oauthFetch = fetchWithProxy, proxyUrl = getProxyUrl, ordinaryFetch = (...args) => globalThis.fetch(...args) } = {}) {
  return async function modelFetch(url, options = {}) {
    if (!isChatGptModelUrl(url)) return ordinaryFetch(url, withOpenCodeSessionHeader(url, options));
    const route = String(url).slice(CHATGPT_BASE_URL.length);
    const method = String(options.method || "GET").toUpperCase();
    const models = route === "/models" && method === "GET";
    if (!models && !(route === "/chat/completions" && method === "POST")) throw new Error("不支持的 ChatGPT 模型请求路径");
    const body = models ? undefined : JSON.stringify(toChatGptResponsesBody(JSON.parse(options.body || "{}")));
    const token = await getAccessToken();
    const response = await oauthFetch(`${API}/${models ? "models" : "responses"}`, {
      method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: models ? "application/json" : "text/event-stream", ...(models ? { "Cache-Control": "no-cache" } : {}) },
      ...(models ? { cache: "no-store" } : {}),
      ...(body ? { body } : {}), signal: options.signal, redirect: "error"
    }, proxyUrl());
    if (!response.ok) return response;
    if (models) {
      const catalog = await response.json();
      if (!Array.isArray(catalog.models)) throw new Error("ChatGPT 模型目录格式无效");
      return Response.json({ object: "list", data: catalog.models.filter((model) => model.visibility === "list" && model.slug).map((model) => ({ id: model.slug, object: "model", display_name: model.display_name || model.slug })) });
    }
    return Response.json(await readChatGptStream(response, { signal: options.signal }));
  };
}

export const chatgptModelFetch = createChatGptModelFetch();

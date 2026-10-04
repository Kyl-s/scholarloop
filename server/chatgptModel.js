import { getChatGptAccessToken } from "./chatgptAuth.js";
import { fetchWithProxy, getProxyUrl } from "./proxy.js";

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

export async function readChatGptStream(response) {
  if (!response.body) throw new Error("ChatGPT 未返回响应流");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let completed = null;
  function event(frame) {
    const data = frame.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
    if (!data || data === "[DONE]") return;
    let value;
    try { value = JSON.parse(data); } catch { throw new Error("ChatGPT 响应流包含无效 JSON"); }
    if (["response.failed", "response.incomplete", "error"].includes(value.type)) {
      const detail = value.response?.error || value.error || value.response?.incomplete_details || value;
      throw new Error(`ChatGPT 请求未完成：${detail.code || detail.reason || detail.message || value.type}`);
    }
    if (value.type === "response.completed") {
      if (!value.response || (value.response.status && value.response.status !== "completed")) throw new Error("ChatGPT 返回了无效完成状态");
      completed = value.response;
    }
  }
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      let separator;
      while ((separator = /\r?\n\r?\n/.exec(buffer))) {
        event(buffer.slice(0, separator.index));
        buffer = buffer.slice(separator.index + separator[0].length);
      }
      if (done) { if (buffer.trim()) event(buffer); break; }
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally { reader.releaseLock(); }
  if (!completed) throw new Error("ChatGPT 响应流中断，未收到 response.completed");
  return completionJson(completed);
}

/** Only the internal marker activates OAuth; ordinary providers retain their fetch behavior. */
export function createChatGptModelFetch({ getAccessToken = getChatGptAccessToken, oauthFetch = fetchWithProxy, proxyUrl = getProxyUrl, ordinaryFetch = (...args) => globalThis.fetch(...args) } = {}) {
  return async function modelFetch(url, options = {}) {
    if (!isChatGptModelUrl(url)) return ordinaryFetch(url, options);
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
    return Response.json(await readChatGptStream(response));
  };
}

export const chatgptModelFetch = createChatGptModelFetch();

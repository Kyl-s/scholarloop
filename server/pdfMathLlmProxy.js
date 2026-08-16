import { randomUUID } from "node:crypto";
import {
  looksLikeBatchJsonRequest,
  sanitizeTranslationModelOutput
} from "./translationQuality.js";

const sessions = new Map();
let listenPort = Number(process.env.PORT || 8787);

export function setPdfMathLlmProxyPort(port) {
  const next = Number(port);
  if (Number.isInteger(next) && next > 0) listenPort = next;
}

export function registerPdfMathLlmSession({ baseUrl, apiKey, model } = {}) {
  const token = randomUUID();
  sessions.set(token, {
    baseUrl: String(baseUrl || "").trim().replace(/\/+$/, ""),
    apiKey: String(apiKey || "").trim(),
    model: String(model || "").trim()
  });
  return token;
}

export function getPdfMathLlmSession(token) {
  return sessions.get(String(token || "")) || null;
}

export function pdfMathLlmProxyUrl(token) {
  return `http://127.0.0.1:${listenPort}/api/internal/pdf-math-llm/${token}`;
}

/** 把 pdf2zh 的上游地址改成本进程代理，译后再剥 JSON/围栏 */
export function applyPdfMathLlmProxyEnv(env) {
  if (!env?.PDF2ZH_OPENAI_BASE_URL) return env;
  if (String(env.PDF2ZH_OPENAI_BASE_URL).includes("/api/internal/pdf-math-llm/")) return env;
  const token = registerPdfMathLlmSession({
    baseUrl: env.PDF2ZH_OPENAI_BASE_URL,
    apiKey: env.PDF2ZH_OPENAI_API_KEY,
    model: env.PDF2ZH_OPENAI_MODEL
  });
  env.PDF2ZH_OPENAI_BASE_URL = pdfMathLlmProxyUrl(token);
  return env;
}

function extractRequestUserText(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  return messages
    .filter((message) => message && (message.role === "user" || message.role === "system"))
    .map((message) => {
      if (typeof message.content === "string") return message.content;
      if (Array.isArray(message.content)) {
        return message.content
          .map((part) => (typeof part === "string" ? part : part?.text || part?.content || ""))
          .join("");
      }
      return "";
    })
    .join("\n");
}

function patchChoiceContent(data, nextText) {
  const choice = data?.choices?.[0];
  if (!choice) return data;
  if (choice.message && typeof choice.message === "object") {
    choice.message.content = nextText;
  } else if (typeof choice.text === "string") {
    choice.text = nextText;
  }
  return data;
}

function choiceContent(data) {
  const choice = data?.choices?.[0];
  const raw = choice?.message?.content ?? choice?.text ?? data?.output_text ?? "";
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw)) {
    return raw.map((part) => (typeof part === "string" ? part : part?.text || "")).join("");
  }
  return raw == null ? "" : String(raw);
}

export async function handlePdfMathLlmProxy(req, res) {
  const session = getPdfMathLlmSession(req.params.token);
  if (!session?.baseUrl || !session.apiKey) {
    res.status(404).json({ error: "翻译代理会话不存在" });
    return;
  }

  const body = req.body && typeof req.body === "object" ? { ...req.body } : {};
  if (!body.model && session.model) body.model = session.model;
  const userText = extractRequestUserText(body);
  const expectJson = looksLikeBatchJsonRequest(userText) || body.response_format?.type === "json_object";

  const upstream = `${session.baseUrl}/chat/completions`;
  const response = await fetch(upstream, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${session.apiKey}`
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(180000)
  });

  const raw = await response.text();
  let data = null;
  try {
    data = raw ? JSON.parse(raw) : {};
  } catch {
    if (!response.ok) {
      res.status(response.status).type("text/plain").send(raw.slice(0, 4000));
      return;
    }
    res.status(502).json({ error: "上游模型返回了无法解析的内容" });
    return;
  }

  if (!response.ok) {
    res.status(response.status).json(data);
    return;
  }

  const content = choiceContent(data);
  if (content) {
    patchChoiceContent(data, sanitizeTranslationModelOutput(content, { expectJson }));
  }
  res.status(200).json(data);
}

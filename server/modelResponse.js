/**
 * Normalize the response shapes used by OpenAI-compatible providers.
 */
export function normalizeModelContent(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value.map((part) => {
      if (typeof part === "string") return part;
      if (part && typeof part === "object") return normalizeModelContent(part.text ?? part.content ?? part.value ?? "");
      return "";
    }).filter(Boolean).join("");
  }
  if (value && typeof value === "object") return normalizeModelContent(value.text ?? value.content ?? value.value ?? "");
  return value == null ? "" : String(value);
}

export function extractModelText(data) {
  const choice = data?.choices?.[0];
  for (const candidate of [choice?.message?.content, choice?.text, data?.output_text]) {
    const text = normalizeModelContent(candidate).trim();
    if (text) return text;
  }
  return "";
}

export function extractModelReasoning(data) {
  const message = data?.choices?.[0]?.message;
  return normalizeModelContent(message?.reasoning_content ?? message?.reasoning ?? data?.reasoning_content ?? "").trim();
}

export function modelResponseError(data) {
  if (extractModelReasoning(data)) return "模型只返回了思考过程，没有最终结果";
  if (data?.error) return "模型接口返回了错误响应";
  return "模型返回为空：接口没有返回最终结果";
}

export function parseJsonFromModelText(text) {
  const clean = String(text || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/```$/i, "").trim();
  const match = clean.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("模型没有返回 JSON 结果");
  try { return JSON.parse(match[0]); } catch { throw new Error("模型返回的 JSON 无法解析"); }
}

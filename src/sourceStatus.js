export function classifySourceError(error) {
  const status = Number(error?.status) || Number(String(error?.message || error).match(/\b(401|403|429|5\d\d)\b/)?.[1]) || null;
  const message = String(error?.message || error || "");
  const type = status === 429 ? "rate_limit"
    : status === 401 || status === 403 ? "access_denied"
    : error?.code === "INVALID_RESPONSE" || error?.name === "SyntaxError" ? "invalid_response"
    : error?.code === "TIMEOUT" || error?.name === "AbortError" || /timeout|timed out|aborted/i.test(message) ? "timeout"
    : status ? "http_error" : "network";
  return { type, httpStatus: status, retryable: type === "rate_limit" || type === "timeout" || type === "network" || status >= 500 };
}

export function summarizeSourceStatus(status) {
  if (status.enabled === false) return "disabled";
  if (status.configured === false) return "unconfigured";
  if (!status.attemptedQueries) return "skipped";
  if (!status.successfulQueries) return "failed";
  if (status.failedQueries) return "partial";
  return status.displayedCount ? "success" : "empty";
}

export function sourceStatusView(status) {
  const state = status.state || (status.ok ? "success" : "failed");
  const labels = { success: "成功", empty: "成功 · 无展示结果", partial: "部分成功", failed: "失败", skipped: "未执行", disabled: "已停用", unconfigured: "未配置授权" };
  return { state, label: labels[state] || "未知", tone: ["success", "empty"].includes(state) ? "ok" : state === "partial" ? "partial" : state === "failed" ? "fail" : "muted" };
}

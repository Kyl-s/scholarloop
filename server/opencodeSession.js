import { randomUUID } from "node:crypto";

let cachedSessionId = "";

/** opencode 网关要求 x-opencode-session；同一进程复用一个稳定标识即可被路由。 */
export function getOpenCodeSessionId() {
  if (!cachedSessionId) {
    cachedSessionId = String(process.env.OPENCODE_SESSION_ID || "").trim() || `scholarloop-${randomUUID()}`;
  }
  return cachedSessionId;
}

export function isOpenCodeModelUrl(url) {
  try {
    const host = new URL(String(url)).hostname.toLowerCase();
    return host === "opencode.ai" || host.endsWith(".opencode.ai");
  } catch {
    return false;
  }
}

export function withOpenCodeSessionHeader(url, options = {}) {
  if (!isOpenCodeModelUrl(url)) return options;
  const headers = normalizeHeaders(options.headers);
  const hasSession = Object.keys(headers).some((name) => name.toLowerCase() === "x-opencode-session");
  if (!hasSession) headers["x-opencode-session"] = getOpenCodeSessionId();
  return { ...options, headers };
}

function normalizeHeaders(headers) {
  if (!headers) return {};
  if (typeof Headers !== "undefined" && headers instanceof Headers) return Object.fromEntries(headers.entries());
  if (Array.isArray(headers)) return Object.fromEntries(headers);
  return { ...headers };
}

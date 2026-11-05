import { fetch as undiciFetch, ProxyAgent } from "undici";
import { spawnSync } from "node:child_process";

let cachedSystemProxy = null;
let systemProxyCheckedAt = 0;
const SYSTEM_PROXY_TTL_MS = 10000;

function envProxy() {
  return process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.ALL_PROXY || null;
}

function windowsSystemProxy() {
  if (process.platform !== "win32") return null;
  const now = Date.now();
  if (systemProxyCheckedAt && now - systemProxyCheckedAt < SYSTEM_PROXY_TTL_MS) return cachedSystemProxy;
  // This synchronous probe also serializes concurrent callers; misses expire too.
  systemProxyCheckedAt = now;
  try {
    const enabled = spawnSync(
      "reg",
      ["query", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings", "/v", "ProxyEnable"],
      { encoding: "utf8", windowsHide: true, timeout: 1000 }
    );
    if (enabled.error || enabled.status !== 0) return cachedSystemProxy;
    if (/0x1/i.test(enabled.stdout || "")) {
      const server = spawnSync(
        "reg",
        ["query", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings", "/v", "ProxyServer"],
        { encoding: "utf8", windowsHide: true, timeout: 1000 }
      );
      if (server.error || server.status !== 0) return cachedSystemProxy;
      const match = (server.stdout || "").match(/ProxyServer\s+REG_SZ\s+(\S+)/i);
      if (match) cachedSystemProxy = match[1].trim();
    } else if (/ProxyEnable\s+REG_DWORD\s+0x0\b/i.test(enabled.stdout || "")) {
      cachedSystemProxy = null;
    }
  } catch {
    /* registry unavailable */
  }
  return cachedSystemProxy;
}

export function getProxyUrl(explicit) {
  if (explicit && String(explicit).trim()) return normalizeProxy(String(explicit).trim());
  return normalizeProxy(envProxy() || windowsSystemProxy());
}

function normalizeProxy(value) {
  const text = String(value || "").trim();
  if (!text) return null;
  if (!/^https?:\/\//i.test(text)) return `http://${text}`;
  return text;
}

const agents = new Map();

function agentFor(proxy) {
  if (!proxy) return undefined;
  if (!agents.has(proxy)) agents.set(proxy, new ProxyAgent(proxy));
  return agents.get(proxy);
}

export async function fetchWithProxy(url, options = {}, proxy) {
  const dispatcher = agentFor(proxy);
  // Keep fetch and its dispatcher on the same Undici version.
  return dispatcher ? undiciFetch(url, { ...options, dispatcher }) : fetch(url, options);
}

export async function fetchWithFallback(url, options = {}, proxy) {
  if (!proxy) return fetch(url, options);
  let proxyRes;
  try {
    proxyRes = await fetchWithProxy(url, options, proxy);
  } catch (err) {
    try {
      return await fetch(url, options);
    } catch (directErr) {
      throw new Error(`${err.message}；直连也失败：${directErr.message}`);
    }
  }
  if (proxyRes.ok) return proxyRes;
  try {
    const direct = await fetch(url, options);
    if (direct.ok) return direct;
    return proxyRes;
  } catch {
    return proxyRes;
  }
}

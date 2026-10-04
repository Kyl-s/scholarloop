import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { jwtVerify, createLocalJWKSet } from "jose";
import { fetchWithProxy, getProxyUrl } from "./proxy.js";
import { chatGptVault } from "./chatgptVault.js";

const ISSUER = "https://auth.openai.com";
const RESOURCE = "https://api.openai.com/v1";
const SCOPE = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
const random = () => randomBytes(32).toString("base64url");

// The installation ID is not a credential; tokens are in the separate DPAPI vault.
function hostId() {
  const dir = path.join(process.env.LOCALAPPDATA || os.homedir(), "ScholarLoop", "chatgpt");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "host-id.txt");
  try { return fs.readFileSync(file, "utf8").trim(); } catch (e) { if (e.code !== "ENOENT") throw e; }
  const id = `urn:uuid:${randomUUID()}`;
  fs.writeFileSync(file, id, { flag: "wx", mode: 0o600 });
  return id;
}

async function network(url, options = {}) {
  return fetchWithProxy(url, { ...options, redirect: "error", signal: options.signal || AbortSignal.timeout(25000) }, getProxyUrl());
}

export async function verifyChatGptIdentity(idToken, clientId, nonce, fetcher = network) {
  const r = await fetcher(`${ISSUER}/.well-known/jwks.json`);
  if (!r.ok) throw new Error("无法获取 ChatGPT 身份验证公钥");
  const { payload } = await jwtVerify(idToken, createLocalJWKSet(await r.json()), {
    issuer: ISSUER, audience: clientId, algorithms: ["RS256"],
    requiredClaims: ["sub", "exp", "iat", "nonce"], clockTolerance: 5
  });
  if (payload.nonce !== nonce || !payload.sub) throw new Error("ChatGPT 身份校验失败");
  return payload;
}

export function createChatGptAuth({ fetcher = network, getHostId = hostId, verifyIdentity = verifyChatGptIdentity, timeoutMs = 300000, vault = null } = {}) {
  let session = null;
  let pending = null;
  let error = "";
  let refresh = null;
  let generation = 0;
  let starting = null;
  // Retain the account/client mapping after logout, without its tokens.
  let registration = null;
  const ready = (async () => {
    if (!vault) return;
    try {
      const saved = await vault.load();
      if (!saved) return;
      if (saved.version !== 1) throw new Error("凭据版本无效");
      registration = saved.registration || null;
      if (saved.session) {
        const value = saved.session;
        if (!value.access_token || !value.clientId || !value.subject || !Array.isArray(value.scopes) || !Number.isFinite(value.expiresAt)
          || registration?.clientId !== value.clientId || registration?.subject !== value.subject) throw new Error("凭据内容无效");
        session = value;
      }
    } catch { error = "ChatGPT 本地加密凭据无法恢复，请重新登录"; }
  })();
  const persist = () => vault?.save({ version: 1, registration, session });

  const stop = () => {
    if (!pending) return;
    clearTimeout(pending.timer);
    pending.server.close();
    pending.server.closeIdleConnections?.();
    pending = null;
  };
  const status = () => ({ connected: Boolean(session), sharing: Boolean(session?.scopes.includes("chatgpt.tokens.use.direct")), pending: Boolean(pending), error });
  async function tokenRequest(params) {
    const r = await fetcher(`${ISSUER}/api/accounts/oauth/token`, {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ ...params, resource: RESOURCE }).toString()
    });
    if (!r.ok) {
      const failure = new Error(`ChatGPT 令牌交换失败（HTTP ${r.status}），请重新登录`);
      failure.reauthenticate = [400, 401, 403].includes(r.status);
      throw failure;
    }
    const data = await r.json();
    if (!data.access_token || !Number.isFinite(Number(data.expires_in)) || Number(data.expires_in) <= 0) throw new Error("ChatGPT 返回的登录凭据不完整");
    return data;
  }

  async function beginLogin() {
    await ready;
    if (pending) return { url: pending.url };
    const installationId = getHostId();
    error = "";
    const epoch = ++generation;
    const attempt = { state: random(), nonce: random(), verifier: random(), clientId: registration?.clientId || "dynamic_agent_client" };
    const server = http.createServer(async (req, res) => {
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Referrer-Policy", "no-referrer");
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      const callback = new URL(req.url, attempt.redirectUri);
      if (req.method !== "GET" || callback.pathname !== "/auth/callback") { res.writeHead(404).end(); return; }
      if (pending !== attempt || attempt.consumed || callback.searchParams.get("state") !== attempt.state) { res.writeHead(400).end("登录状态不匹配，请从 ScholarLoop 重新登录。"); return; }
      attempt.consumed = true; // consume before asynchronous exchange, keep pending for UI polling
      clearTimeout(attempt.timer);
      try {
        if (callback.searchParams.has("error")) throw new Error("ChatGPT 授权未完成，请重新登录并确认授权");
        const code = callback.searchParams.get("code");
        const returnedId = callback.searchParams.get("client_id");
        const clientId = returnedId || attempt.clientId;
        if (!code || !clientId || clientId === "dynamic_agent_client" || (attempt.clientId !== "dynamic_agent_client" && clientId !== attempt.clientId)) throw new Error("ChatGPT 注册回调不完整或客户端不匹配");
        registration = { clientId, subject: registration?.subject };
        await persist();
        const tokens = await tokenRequest({ grant_type: "authorization_code", client_id: clientId, code, code_verifier: attempt.verifier, redirect_uri: attempt.redirectUri });
        const identity = await verifyIdentity(tokens.id_token, clientId, attempt.nonce, fetcher);
        if (registration.subject && registration.subject !== identity.sub) throw new Error("ChatGPT 返回的账号与本次注册不匹配");
        if (epoch !== generation) throw new Error("登录已取消");
        registration = { clientId, subject: identity.sub };
        session = { clientId, subject: identity.sub, ...tokens, scopes: String(tokens.scope || "").split(/\s+/), expiresAt: Date.now() + Number(tokens.expires_in) * 1000 };
        await persist();
        if (epoch !== generation) throw new Error("登录已取消");
        error = "";
        res.end("ChatGPT 登录成功，凭据已由 Windows 加密保存。请返回 ScholarLoop，选择模型并启用。下次启动将自动恢复登录。");
      } catch (e) {
        if (epoch === generation) error = e.message.startsWith("ChatGPT") || e.message === "登录已取消" ? e.message : "ChatGPT 身份验证失败，请重新登录";
        res.writeHead(400).end(error || "登录已取消");
      } finally { if (pending === attempt) stop(); }
    });
    attempt.server = server;
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    if (epoch !== generation) { server.close(); throw new Error("登录已取消"); }
    attempt.redirectUri = `http://127.0.0.1:${server.address().port}/auth/callback`;
    const url = new URL(`${ISSUER}/api/accounts/authorize`);
    url.search = new URLSearchParams({ client_id: attempt.clientId, ...(attempt.clientId === "dynamic_agent_client" ? { agent_name_hint: "ScholarLoop" } : {}), ext_agent_host_id: installationId, response_type: "code", redirect_uri: attempt.redirectUri, scope: SCOPE, resource: RESOURCE, state: attempt.state, nonce: attempt.nonce, code_challenge_method: "S256", code_challenge: createHash("sha256").update(attempt.verifier).digest("base64url") }).toString();
    attempt.url = url.href;
    pending = attempt;
    attempt.timer = setTimeout(() => { if (pending === attempt) { error = "ChatGPT 登录超时，请重新尝试"; stop(); } }, timeoutMs);
    attempt.timer.unref?.();
    return { url: attempt.url };
  }
  function login() {
    if (!starting) starting = beginLogin().finally(() => { starting = null; });
    return starting;
  }

  async function accessToken() {
    await ready;
    if (!session || !status().sharing) throw new Error("请在设置中登录 ChatGPT 并授权套餐使用");
    if (session.expiresAt > Date.now() + 60000) return session.access_token;
    if (!refresh) {
      const selected = session;
      refresh = (async () => {
        if (!selected.refresh_token) {
          const failure = new Error("ChatGPT 登录已过期，请重新登录");
          failure.reauthenticate = true;
          throw failure;
        }
        const tokens = await tokenRequest({ grant_type: "refresh_token", client_id: selected.clientId, refresh_token: selected.refresh_token });
        if (session !== selected) throw new Error("ChatGPT 登录状态已改变");
        session = { ...selected, ...tokens, scopes: tokens.scope === undefined ? selected.scopes : String(tokens.scope).split(/\s+/), expiresAt: Date.now() + Number(tokens.expires_in) * 1000 };
        await persist();
        if (!session) throw new Error("ChatGPT 已退出登录");
        if (!status().sharing) throw new Error("ChatGPT 套餐授权已失效，请重新登录");
        return session.access_token;
      })().catch(async (failure) => {
        if (failure.reauthenticate && session === selected) {
          session = null;
          error = "ChatGPT 授权已过期或被撤销，请重新登录";
          await persist();
        }
        throw failure;
      }).finally(() => { refresh = null; });
    }
    return refresh;
  }

  async function logout() {
    await ready;
    ++generation;
    stop();
    const previous = session;
    session = null;
    error = "";
    await persist();
    if (previous?.refresh_token) {
      try {
        const discovery = await fetcher(`${ISSUER}/.well-known/openid-configuration`);
        if (!discovery.ok) throw new Error();
        const endpoint = new URL((await discovery.json()).revocation_endpoint);
        if (endpoint.origin !== ISSUER) throw new Error();
        const r = await fetcher(endpoint.href, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token: previous.refresh_token, token_type_hint: "refresh_token", client_id: previous.clientId }).toString() });
        if (!r.ok) throw new Error();
      } catch { error = "已退出本机登录；未确认远程撤销，可在 ChatGPT 设置中断开 ScholarLoop。"; }
    }
    return status();
  }
  return { login, logout, status, accessToken, ready };
}

export function isLocalChatGptRequest(req) {
  const host = String(req.headers.host || "");
  if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) return false;
  if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress)) return false;
  if (req.headers["x-forwarded-host"] || req.headers["x-forwarded-for"]) return false;
  const origin = req.headers.origin;
  if (origin && origin !== `http://${host}`) return false;
  if (req.headers["sec-fetch-site"] === "cross-site") return false;
  if (req.method === "POST" && !String(req.headers["content-type"] || "").startsWith("application/json")) return false;
  return true;
}

export const chatGptAuth = createChatGptAuth({ vault: chatGptVault });
export const getChatGptAccessToken = () => chatGptAuth.accessToken();

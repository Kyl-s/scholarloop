import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import { createChatGptAuth, verifyChatGptIdentity, isLocalChatGptRequest } from "./chatgptAuth.js";

function harness(overrides = {}) {
  const requests = [];
  const auth = createChatGptAuth({
    getHostId: () => "urn:uuid:test-host",
    verifyIdentity: async () => ({ sub: "test-subject" }),
    fetcher: async (url, options) => {
      requests.push({ url, params: new URLSearchParams(options?.body) });
      return Response.json({ access_token: "test-access", refresh_token: "test-refresh", id_token: "test-id", expires_in: 3600, scope: "chatgpt.tokens.use.direct" });
    }, ...overrides
  });
  return { auth, requests };
}
async function callback(auth, parameters = {}) {
  const { url } = await auth.login();
  const query = new URL(url).searchParams;
  const result = new URL(query.get("redirect_uri"));
  result.search = new URLSearchParams({ state: query.get("state"), code: "test-code", client_id: "oaiapp_test", ...parameters });
  return { result: await fetch(result), query };
}

test("OAuth callback uses issued client, exact redirect and S256; status never exposes credentials", async (t) => {
  const { auth, requests } = harness(); t.after(() => auth.logout());
  const { result, query } = await callback(auth);
  assert.equal(result.status, 200);
  assert.equal(query.get("client_id"), "dynamic_agent_client");
  assert.equal(query.get("agent_name_hint"), "ScholarLoop");
  assert.equal(requests[0].params.get("client_id"), "oaiapp_test");
  assert.equal(requests[0].params.get("redirect_uri"), query.get("redirect_uri"));
  assert.equal(createHash("sha256").update(requests[0].params.get("code_verifier")).digest("base64url"), query.get("code_challenge"));
  assert.deepEqual(auth.status(), { connected: true, sharing: true, pending: false, error: "" });
  assert.equal(await auth.accessToken(), "test-access");
});
test("invalid state does not consume attempt or exchange a code", async (t) => {
  const { auth, requests } = harness(); t.after(() => auth.logout());
  assert.equal((await callback(auth, { state: "wrong" })).result.status, 400);
  assert.equal(requests.length, 0);
  assert.equal(auth.status().pending, true);
});
test("denial and missing registration cannot authenticate", async () => {
  for (const parameters of [{ error: "access_denied" }, { client_id: "" }]) {
    const { auth, requests } = harness();
    assert.equal((await callback(auth, parameters)).result.status, 400);
    assert.equal(auth.status().connected, false);
    assert.equal(auth.status().pending, false);
    assert.equal(requests.length, 0);
    await auth.logout();
  }
});
test("identity without plan permission cannot request inference", async (t) => {
  const { auth } = harness({ fetcher: async () => Response.json({ access_token: "test", expires_in: 3600, id_token: "id", scope: "openid" }) });
  t.after(() => auth.logout());
  await callback(auth);
  assert.equal(auth.status().connected, true);
  assert.equal(auth.status().sharing, false);
  await assert.rejects(auth.accessToken(), /授权套餐/);
});
test("concurrent login uses one callback and cancel clears pending", async () => {
  const { auth } = harness();
  const [a, b] = await Promise.all([auth.login(), auth.login()]);
  assert.equal(a.url, b.url);
  await auth.logout();
  assert.equal(auth.status().pending, false);
});
test("logout while token exchange is in flight cannot restore credentials", async () => {
  let resolveToken;
  const { auth } = harness({ fetcher: () => new Promise((resolve) => { resolveToken = resolve; }) });
  const response = callback(auth);
  while (!resolveToken) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(auth.status().pending, true);
  await auth.logout();
  resolveToken(Response.json({ access_token: "test", expires_in: 3600, id_token: "id", scope: "chatgpt.tokens.use.direct" }));
  await response;
  assert.equal(auth.status().connected, false);
});
test("local OAuth guard rejects remote host, forwarded traffic and cross-origin requests", () => {
  const req = { method: "POST", socket: { remoteAddress: "127.0.0.1" }, headers: { host: "127.0.0.1:8787", origin: "http://127.0.0.1:8787", "content-type": "application/json" } };
  assert.equal(isLocalChatGptRequest(req), true);
  for (const headers of [{ origin: "https://evil.example" }, { host: "evil.example" }, { "x-forwarded-for": "100.1.1.1" }, { "content-type": "text/plain" }]) {
    assert.equal(isLocalChatGptRequest({ ...req, headers: { ...req.headers, ...headers } }), false);
  }
});
test("ID token verifies signature, audience, nonce and expiry", async () => {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const jwk = await exportJWK(publicKey);
  const fetcher = async () => Response.json({ keys: [{ ...jwk, kid: "test-key", alg: "RS256" }] });
  const token = await new SignJWT({ nonce: "nonce" }).setProtectedHeader({ alg: "RS256", kid: "test-key" }).setIssuer("https://auth.openai.com").setSubject("subject").setAudience("oaiapp_test").setIssuedAt().setExpirationTime("5m").sign(privateKey);
  assert.equal((await verifyChatGptIdentity(token, "oaiapp_test", "nonce", fetcher)).sub, "subject");
  await assert.rejects(verifyChatGptIdentity(token, "other", "nonce", fetcher));
  await assert.rejects(verifyChatGptIdentity(token, "oaiapp_test", "wrong", fetcher));
  const expired = await new SignJWT({ nonce: "nonce" }).setProtectedHeader({ alg: "RS256", kid: "test-key" }).setIssuer("https://auth.openai.com").setSubject("subject").setAudience("oaiapp_test").setIssuedAt().setExpirationTime(1).sign(privateKey);
  await assert.rejects(verifyChatGptIdentity(expired, "oaiapp_test", "nonce", fetcher));
});

test("saved login restores, concurrent refresh rotates once, logout keeps registration only", async () => {
  let saved = null;
  const vault = { load: async () => structuredClone(saved), save: async (record) => { saved = structuredClone(record); } };
  const first = harness({ vault }).auth;
  await callback(first);
  assert.equal(saved.session.access_token, "test-access");
  saved.session.expiresAt = 0;
  let refreshes = 0;
  const second = harness({ vault, fetcher: async (url, options) => {
    if (url.endsWith("openid-configuration")) return Response.json({ revocation_endpoint: "https://auth.openai.com/revoke" });
    if (url.endsWith("/revoke")) return new Response(null, { status: 200 });
    const params = new URLSearchParams(options.body);
    assert.equal(params.get("grant_type"), "refresh_token");
    assert.equal(params.get("client_id"), "oaiapp_test");
    refreshes++;
    await new Promise((resolve) => setTimeout(resolve, 5));
    return Response.json({ access_token: "rotated-access", refresh_token: "rotated-refresh", expires_in: 3600 });
  } }).auth;
  await second.ready;
  assert.equal(second.status().connected, true);
  assert.deepEqual(await Promise.all([second.accessToken(), second.accessToken()]), ["rotated-access", "rotated-access"]);
  assert.equal(refreshes, 1);
  assert.equal(saved.session.refresh_token, "rotated-refresh");
  await second.logout();
  assert.equal(saved.session, null);
  assert.equal(saved.registration.clientId, "oaiapp_test");
  const third = harness({ vault }).auth;
  const { url } = await third.login();
  assert.equal(new URL(url).searchParams.get("client_id"), "oaiapp_test");
  assert.equal(new URL(url).searchParams.has("agent_name_hint"), false);
  await third.logout();
});

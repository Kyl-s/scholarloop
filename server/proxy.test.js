import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { fetchWithProxy } from "./proxy.js";

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return server.address().port;
}

function trackSockets(server, sockets) {
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
}

async function closeServers(servers, sockets) {
  for (const socket of sockets) socket.destroy();
  await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
}

test("fetchWithProxy uses a compatible dispatcher to forward a real HTTP request through a proxy", { timeout: 10000 }, async (t) => {
  const sockets = new Set();
  const target = http.createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ method: request.method, body, marker: request.headers["x-test-marker"] }));
  });
  let proxyCount = 0;
  let proxyUrl;
  const proxy = http.createServer((request, response) => {
    proxyCount++;
    proxyUrl = request.url;
    const upstream = http.request(request.url, {
      method: request.method,
      headers: request.headers
    }, (upstreamResponse) => {
      response.writeHead(upstreamResponse.statusCode, upstreamResponse.headers);
      upstreamResponse.pipe(response);
    });
    upstream.on("socket", (socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
    });
    upstream.on("error", () => response.destroy());
    request.pipe(upstream);
  });
  trackSockets(target, sockets);
  trackSockets(proxy, sockets);
  t.after(() => closeServers([proxy, target], sockets));
  const targetPort = await listen(target);
  const proxyPort = await listen(proxy);
  const response = await fetchWithProxy(`http://127.0.0.1:${targetPort}/model`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Test-Marker": "through-proxy" },
    body: JSON.stringify({ message: "local regression" }),
    signal: AbortSignal.timeout(5000)
  }, `http://127.0.0.1:${proxyPort}`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    method: "POST", body: '{"message":"local regression"}', marker: "through-proxy"
  });
  assert.equal(proxyCount, 1);
  assert.equal(proxyUrl, `http://127.0.0.1:${targetPort}/model`);
});

test("fetchWithProxy can reach a local target without a proxy", { timeout: 10000 }, async (t) => {
  const sockets = new Set();
  const target = http.createServer((_request, response) => response.end("direct connection"));
  trackSockets(target, sockets);
  t.after(() => closeServers([target], sockets));
  const port = await listen(target);
  const response = await fetchWithProxy(`http://127.0.0.1:${port}/`, {
    signal: AbortSignal.timeout(5000)
  });
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "direct connection");
});

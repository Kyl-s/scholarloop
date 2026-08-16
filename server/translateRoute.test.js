import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

async function waitForHealth(url) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(500) });
      if (response.ok) return;
    } catch {
      // The child server may still be starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("ScholarLoop server did not become ready");
}

test("configured translation reaches an OpenAI-compatible model", async () => {
  let modelRequest = null;
  const modelServer = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      modelRequest = JSON.parse(body);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: "本地假模型译文" } }] }));
    });
  });
  const modelPort = await listen(modelServer);
  const portServer = http.createServer();
  const appPort = await listen(portServer);
  await close(portServer);
  const appServer = spawn(process.execPath, ["server/index.js"], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(appPort) },
    stdio: "ignore"
  });

  try {
    await waitForHealth(`http://127.0.0.1:${appPort}/api/health`);
    const response = await fetch(`http://127.0.0.1:${appPort}/api/translate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        text: "This is a translation smoke test.",
        config: {
          baseUrl: `http://127.0.0.1:${modelPort}`,
          apiKey: "dummy-local-test-key",
          model: "mock-model"
        },
        preserveTokens: true
      })
    });

    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.text, "本地假模型译文");
    assert.equal(body.usage.promptTokens, 0);
    assert.equal(modelRequest.messages[0].content.includes("SCHOLARLOOP_KEEP_数字"), true);
  } finally {
    appServer.kill();
    await close(modelServer);
  }
});

test("accepts structured chat completion content returned by compatible providers", async () => {
  const modelServer = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        choices: [{
          message: {
            content: [{ type: "text", text: "结构化格式译文" }]
          }
        }]
      }));
    });
  });
  const modelPort = await listen(modelServer);
  const portServer = http.createServer();
  const appPort = await listen(portServer);
  await close(portServer);
  const appServer = spawn(process.execPath, ["server/index.js"], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(appPort) },
    stdio: "ignore"
  });

  try {
    await waitForHealth(`http://127.0.0.1:${appPort}/api/health`);
    const response = await fetch(`http://127.0.0.1:${appPort}/api/translate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        text: "This is a structured response test.",
        config: {
          baseUrl: `http://127.0.0.1:${modelPort}`,
          apiKey: "dummy-local-test-key",
          model: "mock-model"
        }
      })
    });

    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.text, "结构化格式译文");
    assert.ok(body.usage);
  } finally {
    appServer.kill();
    await close(modelServer);
  }
});

test("strips leaked JSON fences from sidebar translation output", async () => {
  const modelServer = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        choices: [{
          message: {
            content: "```json[{\"id\":1,\"output\":\"通过时间干涉电场实现非侵入性深部脑刺激\"}]```"
          }
        }]
      }));
    });
  });
  const modelPort = await listen(modelServer);
  const portServer = http.createServer();
  const appPort = await listen(portServer);
  await close(portServer);
  const appServer = spawn(process.execPath, ["server/index.js"], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(appPort) },
    stdio: "ignore"
  });

  try {
    await waitForHealth(`http://127.0.0.1:${appPort}/api/health`);
    const response = await fetch(`http://127.0.0.1:${appPort}/api/translate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        text: "Noninvasive Deep Brain Stimulation via Temporally Interfering Electric Fields",
        config: {
          baseUrl: `http://127.0.0.1:${modelPort}`,
          apiKey: "dummy-local-test-key",
          model: "mock-model"
        }
      })
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.text, "通过时间干涉电场实现非侵入性深部脑刺激");
    assert.equal(body.text.includes("```"), false);
    assert.equal(body.text.includes("\"id\""), false);
  } finally {
    appServer.kill();
    await close(modelServer);
  }
});

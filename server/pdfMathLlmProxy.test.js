import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import {
  applyPdfMathLlmProxyEnv,
  getPdfMathLlmSession,
  handlePdfMathLlmProxy,
  registerPdfMathLlmSession,
  setPdfMathLlmProxyPort
} from "./pdfMathLlmProxy.js";

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

test("rewrites pdf2zh env to a local proxy session", () => {
  setPdfMathLlmProxyPort(8787);
  const env = {
    PDF2ZH_OPENAI_BASE_URL: "https://model.example/v1",
    PDF2ZH_OPENAI_API_KEY: "secret",
    PDF2ZH_OPENAI_MODEL: "demo"
  };
  applyPdfMathLlmProxyEnv(env);
  assert.match(env.PDF2ZH_OPENAI_BASE_URL, /^http:\/\/127\.0\.0\.1:8787\/api\/internal\/pdf-math-llm\//);
  const token = env.PDF2ZH_OPENAI_BASE_URL.split("/").pop();
  const session = getPdfMathLlmSession(token);
  assert.equal(session.baseUrl, "https://model.example/v1");
  assert.equal(session.apiKey, "secret");
  assert.equal(session.model, "demo");
});

test("proxy strips fenced JSON on the paragraph fallback path", async () => {
  const upstream = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      choices: [{
        message: {
          content: "```json[  {    \"id\": 1,    \"output\": \"Nir Grossman\"  }]```"
        }
      }]
    }));
  });
  const upstreamPort = await listen(upstream);
  const token = registerPdfMathLlmSession({
    baseUrl: `http://127.0.0.1:${upstreamPort}`,
    apiKey: "dummy",
    model: "mock"
  });

  const req = {
    params: { token },
    body: {
      model: "mock",
      messages: [{ role: "user", content: "Output ONLY the translated zh text.\n\nNir Grossman" }]
    }
  };
  let status = 0;
  let payload = null;
  const res = {
    status(code) {
      status = code;
      return this;
    },
    json(body) {
      payload = body;
      return this;
    }
  };

  try {
    await handlePdfMathLlmProxy(req, res);
    assert.equal(status, 200);
    assert.equal(payload.choices[0].message.content, "Nir Grossman");
  } finally {
    await close(upstream);
  }
});

test("proxy keeps a clean JSON array for BabelDOC batch requests", async () => {
  const upstream = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      choices: [{
        message: {
          content: "```json[{\"id\":0,\"input\":\"hello\",\"output\":\"你好\"}]```"
        }
      }]
    }));
  });
  const upstreamPort = await listen(upstream);
  const token = registerPdfMathLlmSession({
    baseUrl: `http://127.0.0.1:${upstreamPort}`,
    apiKey: "dummy",
    model: "mock"
  });

  const req = {
    params: { token },
    body: {
      messages: [{
        role: "user",
        content: "## Output Format\nReturn a JSON array of the same length.\n[{\"id\":0,\"input\":\"hello\"}]"
      }]
    }
  };
  let payload = null;
  const res = {
    status() { return this; },
    json(body) { payload = body; return this; }
  };

  try {
    await handlePdfMathLlmProxy(req, res);
    assert.equal(payload.choices[0].message.content, "[{\"id\":0,\"output\":\"你好\"}]");
  } finally {
    await close(upstream);
  }
});

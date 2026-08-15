import test from "node:test";
import assert from "node:assert/strict";
import { normalizeAgentConfig, presetModels } from "./agentConfig.js";

test("按接口域名给出常用模型预设", () => {
  assert.ok(presetModels("https://api.deepseek.com/v1").includes("deepseek-chat"));
  assert.ok(presetModels("https://api.openai.com/v1").includes("gpt-4o-mini"));
  assert.deepEqual(presetModels("not-a-url"), []);
});

test("规范化 API 配置时补默认地址和模型", () => {
  assert.deepEqual(normalizeAgentConfig({ apiKey: " sk-test " }), {
    apiKey: "sk-test",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4o-mini"
  });
});

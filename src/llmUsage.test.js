import test from "node:test";
import assert from "node:assert/strict";
import {
  addUsageEvent,
  cacheHitRate,
  contextWindowForModel,
  estimateTokensFromText,
  formatPercent,
  mergeUsages,
  parseChatUsage
} from "./llmUsage.js";

test("解析 OpenAI / DeepSeek 风格的 usage", () => {
  assert.deepEqual(parseChatUsage({
    usage: {
      prompt_tokens: 1200,
      completion_tokens: 300,
      total_tokens: 1500,
      prompt_tokens_details: { cached_tokens: 800 }
    }
  }), {
    promptTokens: 1200,
    completionTokens: 300,
    totalTokens: 1500,
    cachedTokens: 800
  });
  assert.deepEqual(parseChatUsage({
    usage: {
      prompt_tokens: 400,
      completion_tokens: 50,
      prompt_cache_hit_tokens: 120
    }
  }), {
    promptTokens: 400,
    completionTokens: 50,
    totalTokens: 450,
    cachedTokens: 120
  });
});

test("合并多次调用的 token 用量", () => {
  assert.deepEqual(mergeUsages([
    { promptTokens: 100, completionTokens: 20, totalTokens: 120, cachedTokens: 40 },
    { prompt_tokens: 50, completion_tokens: 10, prompt_cache_hit_tokens: 10 }
  ]), {
    promptTokens: 150,
    completionTokens: 30,
    totalTokens: 180,
    cachedTokens: 50
  });
});

test("按模型给出上下文窗口并计算缓存命中率", () => {
  assert.equal(contextWindowForModel("deepseek-chat"), 65536);
  assert.equal(contextWindowForModel("gpt-4o-mini"), 128000);
  assert.equal(formatPercent(cacheHitRate({ promptTokens: 800, cachedTokens: 200 })), "25%");
  assert.equal(cacheHitRate({ promptTokens: 0, cachedTokens: 10 }), 0);
});

test("累计本机用量并按类型归档", () => {
  const store = addUsageEvent(null, {
    kind: "interpret",
    model: "deepseek-chat",
    at: "2026-08-16T00:00:00.000Z",
    promptTokens: 1000,
    completionTokens: 200,
    cachedTokens: 400
  });
  assert.equal(store.totals.calls, 1);
  assert.equal(store.totals.promptTokens, 1000);
  assert.equal(store.byKind.interpret.cachedTokens, 400);
  assert.equal(store.byModel["deepseek-chat"].completionTokens, 200);
  assert.equal(store.recent[0].kind, "interpret");
});

test("忽略没有 usage 的空事件", () => {
  const store = addUsageEvent(null, { kind: "translate", model: "x" });
  assert.equal(store.totals.calls, 0);
});

test("中英混排文本给出粗估 token", () => {
  assert.ok(estimateTokensFromText("摘要 Abstract method") > 0);
  assert.equal(estimateTokensFromText(""), 0);
});

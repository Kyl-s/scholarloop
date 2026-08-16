import test from "node:test";
import assert from "node:assert/strict";
import {
  activeProviderFromStore,
  migrateAgentConfigStore,
  normalizeAgentConfig,
  presetModels,
  providerNameFromBaseUrl,
  removeProviderFromStore,
  setActiveProviderInStore,
  toAgentConfig,
  upsertProviderInStore
} from "./agentConfig.js";

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

test("按接口地址推断供应商名称", () => {
  assert.equal(providerNameFromBaseUrl("https://api.deepseek.com/v1"), "DeepSeek");
  assert.equal(providerNameFromBaseUrl("https://api.moonshot.cn/v1"), "Kimi");
  assert.equal(providerNameFromBaseUrl("https://example.com/v1"), "example.com");
});

test("把旧的单供应商配置迁成列表", () => {
  const store = migrateAgentConfigStore({
    apiKey: "sk-old",
    baseUrl: "https://api.deepseek.com/v1",
    model: "deepseek-chat"
  });
  assert.equal(store.version, 2);
  assert.equal(store.providers.length, 1);
  assert.equal(store.providers[0].name, "DeepSeek");
  assert.equal(store.activeId, store.providers[0].id);
  assert.deepEqual(toAgentConfig(activeProviderFromStore(store)), {
    id: store.providers[0].id,
    name: "DeepSeek",
    apiKey: "sk-old",
    baseUrl: "https://api.deepseek.com/v1",
    model: "deepseek-chat"
  });
});

test("可以添加多个供应商并切换当前启用的", () => {
  let store = migrateAgentConfigStore(null);
  store = upsertProviderInStore(store, {
    name: "DeepSeek",
    apiKey: "sk-ds",
    baseUrl: "https://api.deepseek.com/v1",
    model: "deepseek-chat"
  }, { asNew: true, activate: true }).store;
  store = upsertProviderInStore(store, {
    name: "Kimi",
    apiKey: "sk-kimi",
    baseUrl: "https://api.moonshot.cn/v1",
    model: "kimi-k2"
  }, { asNew: true, activate: false }).store;
  assert.equal(store.providers.length, 2);
  assert.equal(activeProviderFromStore(store).name, "DeepSeek");
  store = setActiveProviderInStore(store, store.providers[1].id);
  assert.equal(activeProviderFromStore(store).name, "Kimi");
  store = removeProviderFromStore(store, store.activeId);
  assert.equal(store.providers.length, 1);
  assert.equal(activeProviderFromStore(store).name, "DeepSeek");
});

test("编辑已有供应商时默认不改当前启用项", () => {
  let store = upsertProviderInStore(null, {
    id: "p-a",
    name: "A",
    apiKey: "sk-a",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4o-mini"
  }, { asNew: false, activate: true }).store;
  store = upsertProviderInStore(store, {
    id: "p-b",
    name: "B",
    apiKey: "sk-b",
    baseUrl: "https://api.deepseek.com/v1",
    model: "deepseek-chat"
  }, { asNew: false, activate: false }).store;
  store = upsertProviderInStore(store, {
    id: "p-b",
    name: "B2",
    apiKey: "sk-b2",
    baseUrl: "https://api.deepseek.com/v1",
    model: "deepseek-reasoner"
  }, { asNew: false, activate: false }).store;
  assert.equal(store.activeId, "p-a");
  assert.equal(store.providers.find((item) => item.id === "p-b").name, "B2");
});

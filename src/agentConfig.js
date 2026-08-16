import { useEffect, useState } from "react";

export const AGENT_CONFIG_KEY = "scholarloop.agent.config";
export const AGENT_CONFIG_EVENT = "scholarloop-agent-config";

export const PROVIDER_MODEL_PRESETS = {
  "api.openai.com": ["gpt-4o-mini", "gpt-4o", "gpt-4.1-mini", "gpt-4.1", "o3-mini", "o3", "o4-mini"],
  "api.deepseek.com": ["deepseek-v4-flash", "deepseek-v4-pro", "deepseek-chat", "deepseek-reasoner"],
  "api.moonshot.cn": ["kimi-latest", "kimi-k2", "moonshot-v1-8k", "moonshot-v1-32k", "moonshot-v1-128k"],
  "dashscope.aliyuncs.com": ["qwen-plus", "qwen-max", "qwen-turbo", "qwen-long", "qwen-vl-max"],
  "open.bigmodel.cn": ["glm-4-plus", "glm-4-flash", "glm-4-air", "glm-4-long"]
};

export const PROVIDER_PRESETS = [
  { name: "OpenAI", baseUrl: "https://api.openai.com/v1" },
  { name: "DeepSeek", baseUrl: "https://api.deepseek.com/v1" },
  { name: "Kimi", baseUrl: "https://api.moonshot.cn/v1" },
  { name: "通义千问", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1" },
  { name: "智谱", baseUrl: "https://open.bigmodel.cn/api/paas/v4" }
];

const HOST_PROVIDER_NAMES = {
  "api.openai.com": "OpenAI",
  "api.deepseek.com": "DeepSeek",
  "api.moonshot.cn": "Kimi",
  "dashscope.aliyuncs.com": "通义千问",
  "open.bigmodel.cn": "智谱"
};

export function emptyAgentConfigStore() {
  return { version: 2, activeId: "", providers: [] };
}

export function providerHost(baseUrl) {
  try {
    return new URL(baseUrl).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

export function presetModels(baseUrl) {
  return PROVIDER_MODEL_PRESETS[providerHost(baseUrl)] || [];
}

export function providerNameFromBaseUrl(baseUrl) {
  const host = providerHost(baseUrl);
  return HOST_PROVIDER_NAMES[host] || host || "自定义接口";
}

export function createProviderId() {
  return `p-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}`;
}

export function normalizeProvider(provider, fallbackId = "") {
  const baseUrl = String(provider?.baseUrl || "").trim() || "https://api.openai.com/v1";
  const id = String(provider?.id || fallbackId || "").trim() || createProviderId();
  return {
    id,
    name: String(provider?.name || "").trim() || providerNameFromBaseUrl(baseUrl),
    apiKey: String(provider?.apiKey || "").trim(),
    baseUrl,
    model: String(provider?.model || "").trim() || presetModels(baseUrl)[0] || "gpt-4o-mini"
  };
}

export function activeProviderFromStore(store) {
  const providers = Array.isArray(store?.providers) ? store.providers : [];
  if (!providers.length) return null;
  return providers.find((item) => item.id === store.activeId) || providers[0] || null;
}

export function toAgentConfig(provider) {
  if (!provider?.apiKey) return null;
  return {
    id: provider.id,
    name: provider.name,
    apiKey: provider.apiKey,
    baseUrl: provider.baseUrl,
    model: provider.model
  };
}

export function migrateAgentConfigStore(raw) {
  if (!raw || typeof raw !== "object") return emptyAgentConfigStore();
  if (Array.isArray(raw.providers)) {
    const providers = raw.providers.map((item) => normalizeProvider(item)).filter((item) => item.apiKey);
    const activeId = providers.some((item) => item.id === raw.activeId) ? raw.activeId : (providers[0]?.id || "");
    return { version: 2, activeId, providers };
  }
  if (raw.apiKey) {
    const provider = normalizeProvider(raw);
    return { version: 2, activeId: provider.id, providers: [provider] };
  }
  return emptyAgentConfigStore();
}

export function upsertProviderInStore(store, input, { activate = false, asNew = false } = {}) {
  const current = migrateAgentConfigStore(store);
  const incomingId = String(input?.id || "").trim();
  const id = asNew ? createProviderId() : (incomingId || current.activeId || createProviderId());
  const provider = normalizeProvider({ ...input, id });
  if (!provider.apiKey) throw new Error("请输入 API Key");
  if (!provider.model) throw new Error("请选择或输入模型");
  const exists = current.providers.some((item) => item.id === provider.id);
  const providers = exists
    ? current.providers.map((item) => item.id === provider.id ? provider : item)
    : [...current.providers, provider];
  const shouldActivate = activate || !current.activeId;
  return {
    store: {
      version: 2,
      activeId: shouldActivate ? provider.id : current.activeId,
      providers
    },
    provider
  };
}

export function setActiveProviderInStore(store, id) {
  const current = migrateAgentConfigStore(store);
  if (!current.providers.some((item) => item.id === id)) {
    throw new Error("供应商不存在");
  }
  return { version: 2, activeId: id, providers: current.providers };
}

export function removeProviderFromStore(store, id) {
  const current = migrateAgentConfigStore(store);
  const providers = current.providers.filter((item) => item.id !== id);
  const activeId = current.activeId === id ? (providers[0]?.id || "") : current.activeId;
  return { version: 2, activeId, providers };
}

export function normalizeAgentConfig(config) {
  const provider = normalizeProvider(config);
  return {
    apiKey: provider.apiKey,
    baseUrl: provider.baseUrl,
    model: provider.model
  };
}

function readRawStore() {
  try {
    if (typeof localStorage === "undefined") return null;
    const raw = localStorage.getItem(AGENT_CONFIG_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function loadAgentConfigStore() {
  return migrateAgentConfigStore(readRawStore());
}

function persistStore(store) {
  const next = migrateAgentConfigStore(store);
  if (typeof localStorage !== "undefined") {
    localStorage.setItem(AGENT_CONFIG_KEY, JSON.stringify(next));
  }
  notifyAgentConfig(toAgentConfig(activeProviderFromStore(next)));
  return next;
}

export function loadAgentConfig() {
  return toAgentConfig(activeProviderFromStore(loadAgentConfigStore()));
}

function notifyAgentConfig(detail) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(AGENT_CONFIG_EVENT, { detail }));
}

export function saveAgentConfig(config) {
  const { store } = upsertProviderInStore(loadAgentConfigStore(), config, { activate: true });
  persistStore(store);
  return loadAgentConfig();
}

export function saveProvider(config, { activate = false, asNew = false } = {}) {
  const { store, provider } = upsertProviderInStore(loadAgentConfigStore(), config, { activate, asNew });
  persistStore(store);
  return provider;
}

export function setActiveProvider(id) {
  persistStore(setActiveProviderInStore(loadAgentConfigStore(), id));
  return loadAgentConfig();
}

export function removeProvider(id) {
  persistStore(removeProviderFromStore(loadAgentConfigStore(), id));
  return loadAgentConfigStore();
}

export function clearAgentConfig() {
  if (typeof localStorage !== "undefined") localStorage.removeItem(AGENT_CONFIG_KEY);
  notifyAgentConfig(null);
}

export function subscribeAgentConfig(callback) {
  if (typeof window === "undefined") return () => {};
  const handler = () => callback(loadAgentConfig());
  window.addEventListener(AGENT_CONFIG_EVENT, handler);
  window.addEventListener("storage", handler);
  return () => {
    window.removeEventListener(AGENT_CONFIG_EVENT, handler);
    window.removeEventListener("storage", handler);
  };
}

export function useAgentConfig() {
  const [config, setConfig] = useState(() => loadAgentConfig());
  useEffect(() => subscribeAgentConfig(setConfig), []);
  return config;
}

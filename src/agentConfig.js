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

export function presetModels(baseUrl) {
  try {
    const host = new URL(baseUrl).hostname.replace(/^www\./, "");
    return PROVIDER_MODEL_PRESETS[host] || [];
  } catch {
    return [];
  }
}

export function loadAgentConfig() {
  try {
    if (typeof localStorage === "undefined") return null;
    const raw = localStorage.getItem(AGENT_CONFIG_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function normalizeAgentConfig(config) {
  return {
    apiKey: String(config?.apiKey || "").trim(),
    baseUrl: String(config?.baseUrl || "").trim() || "https://api.openai.com/v1",
    model: String(config?.model || "").trim() || "gpt-4o-mini"
  };
}

function notifyAgentConfig(detail) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(AGENT_CONFIG_EVENT, { detail }));
}

export function saveAgentConfig(config) {
  const next = normalizeAgentConfig(config);
  if (!next.apiKey) throw new Error("请输入 API Key");
  if (!next.model) throw new Error("请选择或输入模型");
  localStorage.setItem(AGENT_CONFIG_KEY, JSON.stringify(next));
  notifyAgentConfig(next);
  return next;
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

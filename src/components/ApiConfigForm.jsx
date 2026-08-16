import { useEffect, useState } from "react";
import { Check, Pencil, Plus, RefreshCw, ShieldCheck, Trash2 } from "lucide-react";
import { api } from "../api.js";
import {
  loadAgentConfigStore,
  presetModels,
  PROVIDER_PRESETS,
  providerNameFromBaseUrl,
  removeProvider,
  saveProvider,
  setActiveProvider
} from "../agentConfig.js";
import { Badge, Button, IconButton } from "./ui.jsx";

const emptyForm = (preset = null) => ({
  id: "",
  name: preset?.name || "",
  apiKey: "",
  baseUrl: preset?.baseUrl || "https://api.openai.com/v1",
  model: presetModels(preset?.baseUrl || "https://api.openai.com/v1")[0] || "gpt-4o-mini"
});

export default function ApiConfigForm() {
  const [store, setStore] = useState(() => loadAgentConfigStore());
  const [form, setForm] = useState(() => emptyForm());
  const [editingId, setEditingId] = useState("");
  const [adding, setAdding] = useState(false);
  const [models, setModels] = useState([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsError, setModelsError] = useState("");
  const [error, setError] = useState("");
  const [note, setNote] = useState("");

  const active = store.providers.find((item) => item.id === store.activeId) || store.providers[0] || null;
  const configured = Boolean(active?.apiKey);

  const loadModels = async (baseUrlValue, apiKeyValue) => {
    const baseUrl = String(baseUrlValue || "").trim();
    const apiKey = String(apiKeyValue || "").trim();
    if (!baseUrl || !apiKey) {
      setModels(presetModels(baseUrl));
      setModelsError("");
      return;
    }
    setModelsLoading(true);
    setModelsError("");
    try {
      const res = await api.models({ baseUrl, apiKey });
      setModels((res.models || []).length ? res.models : presetModels(baseUrl));
      setModelsError("");
    } catch (err) {
      setModelsError(`获取模型列表失败，已显示常用模型：${err.message}`);
      setModels(presetModels(baseUrl));
    } finally {
      setModelsLoading(false);
    }
  };

  const showProvider = (provider, isNew = false) => {
    const next = provider ? { ...emptyForm(), ...provider } : emptyForm();
    setForm(next);
    setEditingId(isNew ? "" : (provider?.id || ""));
    setAdding(isNew);
    setModels(presetModels(next.baseUrl));
    setModelsError("");
    loadModels(next.baseUrl, next.apiKey);
  };

  const refreshStore = () => {
    const next = loadAgentConfigStore();
    setStore(next);
    return next;
  };

  useEffect(() => {
    const current = loadAgentConfigStore();
    setStore(current);
    const provider = current.providers.find((item) => item.id === current.activeId) || current.providers[0] || null;
    showProvider(provider, !provider);
  }, []);

  const applyPreset = (preset) => {
    const next = {
      ...form,
      name: form.name || preset.name,
      baseUrl: preset.baseUrl,
      model: presetModels(preset.baseUrl)[0] || form.model
    };
    setForm(next);
    setModels(presetModels(preset.baseUrl));
    loadModels(next.baseUrl, next.apiKey);
  };

  const save = (activate) => {
    setError("");
    setNote("");
    try {
      const payload = {
        ...form,
        id: adding ? "" : editingId,
        name: form.name.trim() || providerNameFromBaseUrl(form.baseUrl)
      };
      const saved = saveProvider(payload, { activate: activate || !store.providers.length, asNew: adding });
      const next = refreshStore();
      showProvider(next.providers.find((item) => item.id === saved.id) || saved, false);
      setNote(activate || !store.providers.length ? `已保存并启用 ${saved.name}` : `已保存 ${saved.name}`);
    } catch (err) {
      setError(err.message);
    }
  };

  const activate = (id) => {
    setError("");
    setNote("");
    try {
      const config = setActiveProvider(id);
      const next = refreshStore();
      showProvider(next.providers.find((item) => item.id === id) || null, false);
      setNote(`已切换到 ${config?.name || "当前供应商"}`);
    } catch (err) {
      setError(err.message);
    }
  };

  const remove = (id) => {
    const target = store.providers.find((item) => item.id === id);
    if (!target) return;
    if (!window.confirm(`确定删除供应商「${target.name}」？`)) return;
    setError("");
    setNote("");
    const next = removeProvider(id);
    setStore(next);
    const provider = next.providers.find((item) => item.id === next.activeId) || next.providers[0] || null;
    showProvider(provider, !provider);
    setNote(next.providers.length ? `已删除 ${target.name}` : "已删除全部供应商");
  };

  const customModel = !models.includes(form.model);
  const formTitle = adding || !editingId ? "添加供应商" : `编辑 ${form.name || "供应商"}`;

  return (
    <div className="api-config-form">
      <div className="api-config-status">
        {configured ? <Badge tone="ok">已启用</Badge> : <Badge tone="neutral">未配置</Badge>}
        <p>
          {configured
            ? `当前使用 ${active.name} · ${active.model}。可添加多个 OpenAI 兼容供应商，翻译、解读和 Agent 都用当前启用的这一套。`
            : "添加 DeepSeek、Kimi、通义等 OpenAI 兼容接口。可保存多套，随时切换当前启用的供应商。"}
        </p>
      </div>

      {store.providers.length ? (
        <div className="api-provider-list" role="list">
          {store.providers.map((item) => {
            const isActive = item.id === store.activeId;
            const isEditing = !adding && item.id === editingId;
            return (
              <div
                key={item.id}
                className={`api-provider-row${isActive ? " is-active" : ""}${isEditing ? " is-editing" : ""}`}
                role="listitem"
              >
                <div>
                  <strong>{item.name}</strong>
                  <span>{item.baseUrl.replace(/^https?:\/\//, "")} · {item.model}</span>
                </div>
                <div className="api-provider-row-actions">
                  {isActive ? <Badge tone="ok">使用中</Badge> : (
                    <button type="button" className="api-provider-text-btn" onClick={() => activate(item.id)}>启用</button>
                  )}
                  <IconButton icon={Pencil} label={`编辑 ${item.name}`} onClick={() => showProvider(item, false)} />
                  <IconButton icon={Trash2} label={`删除 ${item.name}`} onClick={() => remove(item.id)} />
                </div>
              </div>
            );
          })}
        </div>
      ) : null}

      <div className="api-provider-add-row">
        <Button variant="ghost" icon={Plus} onClick={() => { setError(""); setNote(""); showProvider(null, true); }}>
          添加供应商
        </Button>
      </div>

      <div className="api-provider-editor">
        <div className="api-provider-editor-head">
          <strong>{formTitle}</strong>
          <div className="api-preset-chips">
            {PROVIDER_PRESETS.map((preset) => (
              <button key={preset.name} type="button" className="api-preset-chip" onClick={() => applyPreset(preset)}>
                {preset.name}
              </button>
            ))}
          </div>
        </div>

        <div className="api-config-grid">
          <label className="proxy-field">
            <span>
              <strong>名称</strong>
              <em>方便区分多套接口，可留空自动按地址填写。</em>
            </span>
            <input
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder={providerNameFromBaseUrl(form.baseUrl)}
            />
          </label>
          <label className="proxy-field">
            <span>
              <strong>API Key</strong>
              <em>只保存在本机浏览器，不会写入 ScholarLoop 数据文件。</em>
            </span>
            <input
              type="password"
              value={form.apiKey}
              onChange={(e) => setForm({ ...form, apiKey: e.target.value })}
              placeholder="sk-..."
            />
          </label>
          <label className="proxy-field">
            <span>
              <strong>接口地址</strong>
              <em>OpenAI 兼容 Chat Completions 地址。</em>
            </span>
            <input
              value={form.baseUrl}
              onChange={(e) => setForm({ ...form, baseUrl: e.target.value })}
              placeholder="https://api.openai.com/v1"
            />
          </label>
          <label className="proxy-field api-model-field">
            <span>
              <strong>模型</strong>
              <em>填好地址和 Key 后可刷新该接口的模型列表，也可手动输入。</em>
            </span>
            <div className="model-picker">
              <select
                value={customModel ? "__custom__" : form.model}
                onChange={(e) => setForm({ ...form, model: e.target.value === "__custom__" ? "" : e.target.value })}
                disabled={modelsLoading}
              >
                {modelsLoading ? <option value="">加载模型中...</option> : null}
                {!modelsLoading && !models.length ? <option value="">暂无可用模型</option> : null}
                {models.map((m) => <option key={m} value={m}>{m}</option>)}
                <option value="__custom__">自定义...</option>
              </select>
              <IconButton
                icon={RefreshCw}
                label="刷新模型列表"
                onClick={() => loadModels(form.baseUrl, form.apiKey)}
                disabled={modelsLoading || !form.baseUrl.trim() || !form.apiKey.trim()}
              />
            </div>
            {customModel ? (
              <input
                value={form.model}
                onChange={(e) => setForm({ ...form, model: e.target.value })}
                placeholder="输入模型名称，如 deepseek-v4-flash"
              />
            ) : null}
            {modelsError ? <span className="model-note warn">{modelsError}</span> : null}
            {modelsLoading ? <span className="model-note">正在获取该接口的模型列表...</span> : null}
          </label>
        </div>
      </div>

      {error ? <p className="agent-error">{error}</p> : null}
      {note ? <p className="settings-msg">{note}</p> : null}

      <div className="institution-actions">
        <Button icon={ShieldCheck} onClick={() => save(false)}>保存</Button>
        {store.providers.length > 0 && (adding || editingId !== store.activeId) ? (
          <Button variant="ghost" icon={Check} onClick={() => save(true)}>保存并启用</Button>
        ) : null}
      </div>
    </div>
  );
}

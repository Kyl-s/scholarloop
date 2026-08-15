import { useEffect, useState } from "react";
import { RefreshCw, ShieldCheck } from "lucide-react";
import { api } from "../api.js";
import { clearAgentConfig, loadAgentConfig, presetModels, saveAgentConfig } from "../agentConfig.js";
import { Badge, Button, IconButton } from "./ui.jsx";

export default function ApiConfigForm() {
  const [form, setForm] = useState({ apiKey: "", baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini" });
  const [models, setModels] = useState([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsError, setModelsError] = useState("");
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [saved, setSaved] = useState(() => loadAgentConfig());

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

  useEffect(() => {
    const current = loadAgentConfig();
    const baseUrl = current?.baseUrl || "https://api.openai.com/v1";
    const apiKey = current?.apiKey || "";
    setSaved(current);
    setForm({
      apiKey,
      baseUrl,
      model: current?.model || presetModels(baseUrl)[0] || "gpt-4o-mini"
    });
    setModels(presetModels(baseUrl));
    loadModels(baseUrl, apiKey);
  }, []);

  const save = () => {
    setError("");
    setNote("");
    try {
      const next = saveAgentConfig(form);
      setSaved(next);
      setForm(next);
      setNote("API 配置已保存，仅保留在本机浏览器");
    } catch (err) {
      setError(err.message);
    }
  };

  const remove = () => {
    clearAgentConfig();
    setSaved(null);
    setError("");
    setNote("已移除 API Key");
  };

  const configured = Boolean(saved?.apiKey);
  const customModel = !models.includes(form.model);

  return (
    <div className="api-config-form">
      <div className="api-config-status">
        {configured ? <Badge tone="ok">已启用</Badge> : <Badge tone="neutral">未配置</Badge>}
        <p>{configured ? `当前模型 ${saved.model}` : "填写 OpenAI 兼容的 API Key、接口地址和模型后，Agent、翻译、PDF 解读和 AI 检索即可使用。"}</p>
      </div>

      <div className="api-config-grid">
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
            <em>OpenAI 兼容 Chat Completions 地址，例如 DeepSeek、Kimi、通义。</em>
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

      {error ? <p className="agent-error">{error}</p> : null}
      {note ? <p className="settings-msg">{note}</p> : null}

      <div className="institution-actions">
        <Button icon={ShieldCheck} onClick={save}>保存配置</Button>
        {configured ? <Button variant="ghost" onClick={remove}>移除 Key</Button> : null}
      </div>
    </div>
  );
}

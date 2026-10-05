import { useEffect, useState } from "react";
import { Check, RefreshCw } from "lucide-react";
import { api } from "../api.js";
import { loadAgentConfigStore, removeProvider, saveProvider } from "../agentConfig.js";
import { Badge, Button, IconButton } from "./ui.jsx";

export const CHATGPT_PROVIDER_ID = "chatgpt-oauth";
const COMMON_CHATGPT_MODELS = ["gpt-6.1-sol", "gpt-6-astra", "gpt-6-sol", "gpt-6-luna"];

export default function ChatGptLogin({ onChanged }) {
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [loginUrl, setLoginUrl] = useState("");
  const [models, setModels] = useState([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsError, setModelsError] = useState("");
  const [model, setModel] = useState(() => loadAgentConfigStore().providers.find((item) => item.id === CHATGPT_PROVIDER_ID)?.model || "");
  const [note, setNote] = useState("");
  const [modelRefresh, setModelRefresh] = useState(0);

  useEffect(() => {
    let cancelled = false;
    let timer;
    const check = async () => {
      try {
        const next = await api.get("/api/chatgpt/status");
        if (cancelled) return;
        setStatus(next);
        setError(next.error || "");
        timer = setTimeout(check, next.pending ? 2000 : 30000);
      } catch (err) {
        if (!cancelled) {
          setError(err.message);
          if (status?.pending) timer = setTimeout(check, 2000);
        }
      }
    };
    check();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [status?.pending]);

  useEffect(() => {
    if (!status?.connected || !status.sharing) { setModels([]); setModelsLoading(false); setModelsError(""); return; }
    let cancelled = false;
    setModelsLoading(true);
    setModelsError("");
    api.get("/api/chatgpt/models").then((result) => {
      if (cancelled) return;
      const available = (result.models || []).filter((item) => typeof item === "string");
      setModels(available);
      setModel((previous) => previous || available[0] || "");
    }).catch((err) => {
      if (!cancelled) setModelsError(err.message);
    }).finally(() => { if (!cancelled) setModelsLoading(false); });
    return () => { cancelled = true; };
  }, [status?.connected, status?.sharing, modelRefresh]);

  const login = async () => {
    setBusy(true);
    setError("");
    setNote("");
    try {
      const result = await api.post("/api/chatgpt/login");
      const url = new URL(result.url);
      if (url.protocol !== "https:" || url.hostname !== "auth.openai.com") throw new Error("登录服务返回了无效的授权地址");
      setLoginUrl(url.href);
      setStatus((previous) => ({ ...previous, pending: true }));
      window.open(url.href, "_blank", "noopener,noreferrer");
    } catch (err) { setError(err.message); }
    finally { setBusy(false); }
  };

  const logout = async () => {
    setBusy(true);
    setError("");
    try {
      const result = await api.post("/api/chatgpt/logout");
      removeProvider(CHATGPT_PROVIDER_ID);
      setStatus(result);
      setLoginUrl("");
      setNote(result.error || "已退出 ChatGPT 登录");
      onChanged?.();
    } catch (err) { setError(err.message); }
    finally { setBusy(false); }
  };

  const enable = () => {
    try {
      saveProvider({ id: CHATGPT_PROVIDER_ID, name: "ChatGPT OAuth", baseUrl: "scholarloop-chatgpt://local", apiKey: "oauth-managed", model: model.trim() }, { activate: true });
      setNote(`已启用 ChatGPT OAuth · ${model}`);
      setError("");
      onChanged?.();
    } catch (err) { setError(err.message); }
  };

  const modelOptions = [...new Set([...models, ...COMMON_CHATGPT_MODELS])];
  const customModel = !modelOptions.includes(model);

  return (
    <section className="api-provider-editor" aria-label="ChatGPT OAuth 登录">
      <div className="api-provider-editor-head">
        <strong>ChatGPT OAuth（实验性）</strong>
        <Badge tone={status?.connected ? "ok" : "neutral"}>{status?.connected ? "已登录" : status?.pending ? "等待授权" : "未登录"}</Badge>
      </div>
      <p>使用 ChatGPT 账号授权，无需填写 API Key。凭据由 Windows 加密保存在本机，重启后自动恢复，令牌到期自动刷新。可用模型和额度由账号套餐决定。</p>
      {status?.connected && !status.sharing ? <p className="model-note warn">账号已登录，但尚未获得套餐额度使用权限，暂时无法启用模型。</p> : null}
      <div className="institution-actions">
        {!status?.connected ? <Button type="button" onClick={login} disabled={busy || !status || status.pending}>Continue with ChatGPT</Button> : null}
        {status?.connected || status?.pending ? <Button type="button" variant="ghost" onClick={logout} disabled={busy}>{status.connected ? "退出登录" : "取消登录"}</Button> : null}
      </div>
      {status?.pending && loginUrl ? <p className="model-note">请在授权页面完成登录。若浏览器未打开，<a href={loginUrl} target="_blank" rel="noopener noreferrer">点击打开授权页面</a>。</p> : null}
      {status?.connected && status.sharing ? (
        <>
          <div className="api-config-grid">
            <label className="proxy-field api-model-field">
              <span>
                <strong>ChatGPT 模型</strong>
                <em>刷新最新模型列表，也可输入其他模型 ID。</em>
              </span>
              <div className="model-picker">
                <select aria-label="ChatGPT 模型" value={customModel ? "__custom__" : model} onChange={(event) => setModel(event.target.value === "__custom__" ? "" : event.target.value)} disabled={modelsLoading}>
                  {modelsLoading && !models.length ? <option value="">加载模型中...</option> : null}
                  {modelOptions.map((item) => <option key={item} value={item}>{item}</option>)}
                  <option value="__custom__">自定义...</option>
                </select>
                <IconButton
                  type="button"
                  icon={RefreshCw}
                  label="刷新 ChatGPT 模型列表"
                  onClick={() => setModelRefresh((value) => value + 1)}
                  disabled={modelsLoading}
                />
              </div>
              {customModel ? <input aria-label="自定义 ChatGPT 模型" value={model} onChange={(event) => setModel(event.target.value)} placeholder="输入模型 ID，如 gpt-6.1-sol" /> : null}
              {modelsLoading ? <span className="model-note" role="status">正在获取账号的模型列表...</span> : null}
              {modelsError ? <span className="model-note warn" role="alert">获取模型列表失败：{modelsError}</span> : null}
            </label>
          </div>
          <div className="institution-actions">
            <Button type="button" icon={Check} onClick={enable} disabled={busy || modelsLoading || !model.trim()}>启用此模型</Button>
          </div>
        </>
      ) : null}
      {error ? <p className="agent-error" role="alert">{error}</p> : null}
      {note ? <p className="settings-msg" role="status">{note}</p> : null}
    </section>
  );
}

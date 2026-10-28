import "./ZoteroSettings.css";
import { useEffect, useRef, useState } from "react";
import { CloudUpload, RefreshCw, ShieldCheck } from "lucide-react";
import { Badge, Button } from "./ui.jsx";

async function zoteroRequest(path, body) {
  const response = await fetch(`/api/zotero/${path}`, body === undefined ? {} : {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Zotero 请求失败（${response.status}）`);
  return data;
}

function useZotero() {
  const [status, setStatus] = useState(null);
  const [pending, setPending] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const mounted = useRef(false);
  const actionLock = useRef(false);
  useEffect(() => {
    mounted.current = true;
    let timer;
    let stopped = false;
    const poll = async () => {
      let next;
      try {
        next = await zoteroRequest("status");
        if (!stopped) setStatus(next);
      } catch (err) {
        if (!stopped) setError(err.message);
      }
      if (!stopped) timer = setTimeout(poll, next?.busy || next?.lastRun?.running ? 1500 : 10000);
    };
    poll();
    return () => { stopped = true; mounted.current = false; clearTimeout(timer); };
  }, []);
  const action = async (name, body = {}) => {
    if (actionLock.current) return false;
    actionLock.current = true;
    setPending(name);
    setError("");
    setMessage("");
    try {
      await zoteroRequest(name, body);
      const next = await zoteroRequest("status");
      if (mounted.current) {
        setStatus(next);
        setMessage(({ config: "配置已保存", test: "连接验证成功", disconnect: "已断开连接；Zotero 中已有文献会保留", sync: "同步已启动，可在此查看进度" })[name] || "");
      }
      return true;
    } catch (err) {
      if (mounted.current) setError(err.message);
      return false;
    } finally {
      actionLock.current = false;
      if (mounted.current) setPending("");
    }
  };
  return { status, pending, error, message, action };
}

function ZoteroProgress({ run }) {
  const [page, setPage] = useState(0);
  useEffect(() => setPage(0), [run?.startedAt]);
  const results = run?.results || [];
  const pageCount = Math.max(1, Math.ceil(results.length / 5));
  const current = Math.min(page, pageCount - 1);
  const resultLabel = { synced: "已同步", skipped: "已是最新", failed: "失败", "metadata-only": "仅条目", metadata_only: "仅条目", metadataOnly: "仅条目", success: "已同步" };
  const pdfLabel = { uploaded: "已上传", unchanged: "已是最新", missing: "缺少文件", failed: "上传失败", skipped: "未上传", unavailable: "暂不可用" };
  return (
    <div className="zotero-progress" aria-live="polite">
      <h3>同步进度</h3>
      {!run ? <p className="zotero-muted">连接后点击“同步全部文献”，在这里查看原文和中文译文的上传结果。</p> : <>
        <div className="zotero-stats">
          <div><strong>{run.processed || 0} / {run.total || 0}</strong><span>{run.running ? "正在同步" : "最近同步"}</span></div>
          <div><strong>{run.synced || 0}</strong><span>已同步</span></div>
          <div><strong>{run.metadataOnly || 0}</strong><span>仅条目</span></div>
          <div><strong>{run.failed || 0}</strong><span>失败</span></div>
        </div>
        {run.running ? <progress aria-label="Zotero 同步进度" value={run.processed || 0} max={Math.max(1, run.total || 0)} /> : null}
        {run.error ? <p className="error-text" role="alert">{run.error}</p> : null}
        {results.length ? <details className="zotero-results">
          <summary>查看 {results.length} 篇同步结果</summary>
          <ul>{results.slice(current * 5, current * 5 + 5).map((result, index) => <li key={`${result.id}-${index}`}>
            <div className="zotero-result-head"><strong>{result.title || result.id}</strong><Badge tone={result.status === "failed" ? "neutral" : "success"}>{resultLabel[result.status] || result.status}</Badge></div>
            <p className="zotero-file-status">原文：{pdfLabel[result.pdfStatus] || result.pdfStatus || "未上传"}</p>
            <p className="zotero-file-status">中文：{result.translationMessage || (result.translationStatus === "synced" ? "已同步" : "本次记录未包含中文译文，请重新同步")}</p>
            {result.error ? <p className="error-text">{result.error}</p> : null}
          </li>)}</ul>
          {pageCount > 1 ? <div className="zotero-pagination"><Button type="button" variant="ghost" disabled={current === 0} onClick={() => setPage(current - 1)}>上一页</Button><span>{current + 1} / {pageCount}</span><Button type="button" variant="ghost" disabled={current === pageCount - 1} onClick={() => setPage(current + 1)}>下一页</Button></div> : null}
        </details> : null}
      </>}
    </div>
  );
}

export default function ZoteroSettings() {
  const { status, pending, error, message, action } = useZotero();
  const [apiKey, setApiKey] = useState("");
  const [collectionName, setCollectionName] = useState("ScholarLoop");
  const [autoSync, setAutoSync] = useState(false);
  const initialized = useRef(false);
  useEffect(() => {
    if (!status || initialized.current) return;
    initialized.current = true;
    setCollectionName(status.collectionName || "ScholarLoop");
    setAutoSync(Boolean(status.autoSync));
  }, [status]);
  const busy = Boolean(pending || status?.busy || status?.lastRun?.running);
  const save = async (event) => {
    event.preventDefault();
    const saved = await action("config", { ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}), collectionName: collectionName.trim() || "ScholarLoop", autoSync });
    if (saved) setApiKey("");
  };
  const disconnect = async () => {
    if (!window.confirm("断开 Zotero 连接？这只会移除本机授权，不会删除 Zotero 中已有的文献。")) return;
    if (await action("disconnect")) { setApiKey(""); setAutoSync(false); }
  };
  return (
    <section className="panel settings-panel zotero-settings-panel">
      <div className="settings-head"><CloudUpload size={17} /> Zotero 手机阅读 <Badge tone="neutral">{!status ? "读取中…" : status.configured ? "已配置" : "未连接"}</Badge></div>
      <p className="institution-intro">将文献、原文 PDF 和完整中文译文同步到 Zotero，在 iPhone 登录同一账号即可下载阅读。</p>
      {status?.configured ? <p className="settings-note-text">账号：{status.username || status.userID || "已授权"} · 分类：{status.collectionName || "ScholarLoop"}</p> : null}
      <div className="zotero-columns"><div className="zotero-connection">
      <h3>连接与同步</h3>
      <form onSubmit={save}>
        <label className="proxy-field"><span><strong>Zotero API Key</strong><em>在 Zotero 官网创建，允许访问个人库、写入文献及文件访问。保存后清空输入框，留空保留已配置授权。</em></span><input type="password" autoComplete="new-password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder={status?.configured ? "已配置；输入新 Key 可替换" : "粘贴 Zotero API Key"} disabled={busy} /></label>
        <p className="settings-note-text"><a href="https://www.zotero.org/settings/keys/new" target="_blank" rel="noreferrer">创建 Zotero API Key</a> · 不需要填写账号密码</p>
        <label className="proxy-field"><span><strong>目标分类名称</strong><em>自动创建或使用个人库中同名分类。</em></span><input value={collectionName} onChange={(e) => setCollectionName(e.target.value)} maxLength={200} placeholder="ScholarLoop" disabled={busy} /></label>
        <label className="settings-toggle-row"><span><strong>自动同步新增或更新的文献</strong><em>开启后，应用运行时会自动上传文献、原文及完整中文 PDF；保存配置后生效。</em></span><input type="checkbox" checked={autoSync} onChange={(e) => setAutoSync(e.target.checked)} disabled={busy} /><i className="toggle-track" /></label>
        <div className="institution-actions" style={{ flexWrap: "wrap" }}>
          <Button type="submit" icon={ShieldCheck} disabled={!status || busy || (!status.configured && !apiKey.trim())}>{pending === "config" ? "保存中…" : "保存配置"}</Button>
          <Button type="button" variant="secondary" onClick={() => action("test")} disabled={!status?.configured || busy}>{pending === "test" ? "验证中…" : "验证已保存的连接"}</Button>
          <Button type="button" variant="secondary" icon={RefreshCw} onClick={() => action("sync")} disabled={!status?.configured || busy}>{status?.busy || status?.lastRun?.running ? "同步中…" : "同步全部文献"}</Button>
          {status?.configured ? <Button type="button" variant="ghost" onClick={disconnect} disabled={busy}>断开连接</Button> : null}
        </div>
      </form>
      <details className="zotero-help"><summary>同步范围与存储说明</summary><p>原文与完整中文排版译文作为同一条目下的独立 PDF 附件上传。逐页译文需全部完成后同步；没有译文时仍可同步原文。</p><p>附件占用 Zotero Storage 容量；暂不支持 WebDAV。AI 解读和学习记录保留在 ScholarLoop。Zotero 的修改、删除与批注不会回传。</p></details>
      {error || status?.error ? <p className="error-text" role="alert">{error || status.error}</p> : null}
      {message ? <p className="settings-msg" role="status">{message}</p> : null}
      </div><ZoteroProgress run={status?.lastRun} /></div>
    </section>
  );
}

export function ZoteroLibrarySync({ empty = false }) {
  const { status, pending, error, message, action } = useZotero();
  const busy = Boolean(pending || status?.busy || status?.lastRun?.running);
  return (
    <section className="panel zotero-library-sync" style={{ padding: 16, marginBottom: 16 }} aria-label="Zotero 同步">
      <div className="institution-actions" style={{ flexWrap: "wrap" }}><Button size="sm" variant="secondary" icon={CloudUpload} onClick={() => action("sync")} disabled={!status?.configured || busy || empty}>{busy ? "Zotero 同步中…" : "同步全部文献到 Zotero"}</Button><span className="settings-note-text">{status?.configured ? `分类：${status.collectionName || "ScholarLoop"} · ${status.autoSync ? "自动同步已开启" : "手动同步"}` : "请先在设置中连接 Zotero，随后可在 iPhone 阅读 PDF。"}</span></div>
      {error || status?.error ? <p className="error-text" role="alert">{error || status.error}</p> : null}
      {message ? <p className="settings-msg" role="status">{message}</p> : null}
      <ZoteroProgress run={status?.lastRun} />
    </section>
  );
}

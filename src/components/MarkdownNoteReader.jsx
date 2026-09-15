import { useEffect, useState } from "react";
import { BookOpen, ExternalLink, LoaderCircle, X } from "lucide-react";
import { renderMarkdown } from "./markdown.jsx";
import { Button } from "./ui.jsx";

function isMarkdown(item) {
  return String(item?.name || "").toLowerCase().endsWith(".md") || item?.ext === "md";
}

export function openNoteFile(item) {
  if (typeof window !== "undefined" && typeof window.scholarloop?.openNoteFile === "function") {
    return window.scholarloop.openNoteFile(item.id);
  }
  const url = item?.url || "";
  if (url) window.open(url, "_blank", "noopener,noreferrer");
  return Promise.resolve({ ok: true, mode: "browser-fallback" });
}

export function MarkdownOpenChooser({ item, onClose, onRead }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  if (!item || !isMarkdown(item)) return null;

  const handleSystemOpen = async () => {
    setBusy(true);
    setError("");
    try {
      const result = await openNoteFile(item);
      if (!result?.canceled) onClose?.();
    } catch (err) {
      setError(err.message || "无法打开 Markdown 文件");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="md-open-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose?.(); }}>
      <section className="panel md-open-dialog" role="dialog" aria-modal="true" aria-labelledby="md-open-title">
        <div className="md-open-head">
          <div>
            <strong id="md-open-title">打开 Markdown 文档</strong>
            <span title={item.name}>{item.name}</span>
          </div>
          <button type="button" className="memory-close" aria-label="关闭" onClick={onClose}><X size={17} /></button>
        </div>
        <p className="md-open-desc">选择打开方式。直接打开会使用系统默认程序；内置阅读器支持 Markdown 和 LaTeX 公式。</p>
        <div className="md-open-actions">
          <Button type="button" icon={ExternalLink} disabled={busy} onClick={handleSystemOpen}>直接打开</Button>
          <Button type="button" variant="ghost" icon={BookOpen} disabled={busy} onClick={() => onRead?.(item)}>ScholarLoop 内置阅读器</Button>
        </div>
        {busy ? <p className="md-open-status">正在打开…</p> : null}
        {error ? <p className="error-text">{error}</p> : null}
      </section>
    </div>
  );
}

export default function MarkdownNoteReader({ item, onClose }) {
  const [content, setContent] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!item?.url) return undefined;
    const controller = new AbortController();
    setLoading(true);
    setError("");
    fetch(item.url, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(`读取失败（${response.status}）`);
        return response.text();
      })
      .then(setContent)
      .catch((err) => {
        if (err.name !== "AbortError") setError(err.message || "读取 Markdown 文档失败");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [item?.url]);

  if (!item) return null;

  return (
    <div className="md-reader-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose?.(); }}>
      <section className="md-reader-panel" role="dialog" aria-modal="true" aria-labelledby="md-reader-title">
        <header className="md-reader-head">
          <div>
            <strong id="md-reader-title">{item.name}</strong>
            <span>ScholarLoop 内置 Markdown 阅读器 · 支持 LaTeX</span>
          </div>
          <button type="button" className="memory-close" aria-label="关闭阅读器" onClick={onClose}><X size={18} /></button>
        </header>
        <main className="md-reader-body">
          {loading ? (
            <div className="md-reader-loading"><LoaderCircle size={18} className="spin" />正在读取文档…</div>
          ) : error ? (
            <p className="error-text">{error}</p>
          ) : (
            <article className="md-reader-content">{renderMarkdown(content)}</article>
          )}
        </main>
      </section>
    </div>
  );
}

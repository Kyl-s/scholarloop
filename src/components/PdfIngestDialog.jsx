import { useEffect, useState } from "react";
import { FileText, Link2, Loader2, Download, Search } from "lucide-react";
import { api } from "../api.js";
import { useData } from "../store.jsx";
import { Button, Modal } from "./ui.jsx";

/** 从 URL 中提取 DOI（支持 doi.org/10.xxxx 与裸 10.xxxx 模式） */
export function extractDoi(url) {
  if (!url) return "";
  // 先去掉 doi.org 前缀，再匹配裸 DOI 模式
  const cleaned = String(url).replace(/^https?:\/\/(dx\.)?doi\.org\//i, "");
  const match = cleaned.match(/10\.\d{4,9}\/[^\s"'<>?#]+/i);
  if (!match) return "";
  // 去掉尾部常见标点
  return match[0].replace(/[.,;]+$/, "");
}

/** 从下载文件名推导默认标题（去掉 .pdf 扩展名） */
export function defaultTitle(filename) {
  const name = String(filename || "").trim();
  if (!name) return "";
  return name.replace(/\.pdf$/i, "").trim();
}

/**
 * PDF 入库确认对话框：
 * 捕获到浏览器下载 PDF 时弹出，用户确认后调用
 * POST /api/import/pdf-from-url 让服务端下载并创建文献记录。
 * preload 的 scholarloopDownloads API 可能尚未就绪，所有访问都判空。
 */
export default function PdfIngestDialog({ download, onClose, onIngested }) {
  const { refresh } = useData();
  const [form, setForm] = useState({
    title: defaultTitle(download?.filename),
    doi: extractDoi(download?.url) || extractDoi(download?.sourceUrl),
    sourceUrl: download?.sourceUrl || "",
    authors: "",
    year: "",
    venue: ""
  });
  const [loading, setLoading] = useState(false);
  const [resolving, setResolving] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(null);
  // 「仍另存到磁盘」的结果提示
  const [saveState, setSaveState] = useState(null);

  const setField = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

  // 订阅另存结果（preload API 缺失时静默不启用）
  useEffect(() => {
    const off = window.scholarloopDownloads?.onPdfDownloadSaved?.((info) => {
      setSaveState(info || {});
    });
    return () => {
      if (typeof off === "function") off();
    };
  }, []);

  // 按 DOI 解析元数据，预填作者/年份/期刊/标题
  const resolveByDoi = async () => {
    const doi = form.doi.trim();
    if (!doi) return;
    setResolving(true);
    setError("");
    try {
      const paper = await api.post("/api/import", { type: "doi", data: doi });
      setForm((f) => ({
        ...f,
        title: f.title.trim() || paper.title || f.title,
        authors: Array.isArray(paper.authors) ? paper.authors.join(", ") : paper.authors || f.authors,
        year: paper.year ? String(paper.year) : f.year,
        venue: paper.venue || f.venue,
        doi
      }));
    } catch (err) {
      setError(err.message || "DOI 解析失败");
    } finally {
      setResolving(false);
    }
  };

  // 提交入库：让服务端按 URL 下载 PDF 并创建文献记录
  const submit = async () => {
    setLoading(true);
    setError("");
    try {
      const body = {
        url: download?.url || "",
        // cookie 原样透传给服务端（可能为字符串或对象）
        cookie: download?.cookies || "",
        title: form.title.trim(),
        doi: form.doi.trim(),
        sourceUrl: form.sourceUrl.trim()
      };
      if (form.authors.trim()) {
        // authors 支持数组或逗号分隔字符串，这里统一转数组
        body.authors = form.authors.split(/[,，]/).map((s) => s.trim()).filter(Boolean);
      }
      if (form.year.trim()) body.year = form.year.trim();
      if (form.venue.trim()) body.venue = form.venue.trim();
      const result = await api.importPdfFromUrl(body);
      if (result?.ok === false) throw new Error(result.error || "PDF 入库失败");
      setDone(result?.paper || null);
      await refresh();
      // 短暂展示成功提示后关闭
      setTimeout(() => onIngested?.(result?.paper), 1200);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  // 次要操作：放弃拦截，走系统「另存为」对话框
  const saveToDisk = () => {
    setSaveState(null);
    window.scholarloopDownloads?.savePdfAs?.(download?.downloadId);
  };

  return (
    <Modal title="PDF 入库确认" onClose={onClose} width="560px">
      <div className="import-form">
        <p className="form-note"><FileText size={13} /> 捕获到 PDF 下载：{download?.filename || download?.url || "未知文件"}</p>
        <label>标题 <input value={form.title} onChange={setField("title")} placeholder="论文标题" /></label>
        <div className="two-col">
          <label>DOI <input value={form.doi} onChange={setField("doi")} placeholder="10.xxxx/xxxxx（可选）" /></label>
          <label>识别 DOI
            <Button size="sm" variant="ghost" icon={resolving ? Loader2 : Search} onClick={resolveByDoi} disabled={resolving || !form.doi.trim()}>
              {resolving ? "识别中" : "按 DOI 补全元数据"}
            </Button>
          </label>
        </div>
        <label>作者（逗号分隔，可留空） <input value={form.authors} onChange={setField("authors")} placeholder="作者1, 作者2" /></label>
        <div className="two-col">
          <label>年份 <input value={form.year} onChange={setField("year")} placeholder="可选" /></label>
          <label>来源/期刊 <input value={form.venue} onChange={setField("venue")} placeholder="可选" /></label>
        </div>
        <label>来源链接 <input value={form.sourceUrl} onChange={setField("sourceUrl")} placeholder={download?.url || "https://..."} /></label>
        {done ? (
          <p className="form-note"><Link2 size={13} /> 已入库：{done.title || form.title}</p>
        ) : null}
        {error ? <p className="error-text">{error}</p> : null}
        {saveState ? (
          saveState.ok ? (
            <p className="form-note"><Download size={13} /> 已保存到：{saveState.path || "所选位置"}</p>
          ) : (
            <p className="error-text">另存失败：{saveState.error || "未知错误"}</p>
          )
        ) : null}
      </div>
      <div className="import-actions">
        <Button variant="ghost" onClick={saveToDisk} disabled={!download?.downloadId || !window.scholarloopDownloads?.savePdfAs}>
          仍另存到磁盘
        </Button>
        <Button variant="ghost" onClick={onClose}>取消</Button>
        <Button icon={loading ? Loader2 : FileText} onClick={submit} disabled={loading || Boolean(done)}>
          {loading ? "入库中" : "确认入库"}
        </Button>
      </div>
    </Modal>
  );
}

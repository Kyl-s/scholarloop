import { useEffect, useMemo, useState } from "react";
import { Plus, Search, Trash2, FileText, Link2, Braces, ExternalLink, AppWindow, Loader2, BookOpen } from "lucide-react";
import { api } from "../api.js";
import { useData } from "../store.jsx";
import PaperDetail from "../components/PaperDetail.jsx";
import { ZoteroLibrarySync } from "../components/ZoteroSettings.jsx";
import { Badge, Button, EmptyState, IconButton, Modal, Segmented, SourceTag, Stars, TextArea, formatDate } from "../components/ui.jsx";
import { openPdfExternal } from "../openPdfExternal.js";
import { loadAgentConfig } from "../agentConfig.js";

const STATUS_OPTIONS = [
  { value: "all", label: "全部" },
  { value: "todo", label: "待读" },
  { value: "reading", label: "在读" },
  { value: "understood", label: "已懂" },
  { value: "retold", label: "已复述" }
];

export default function LibraryPage({ focusPaper, onFocusCleared, onReadPdf }) {
  const { library, meta, savePaper, updatePaper, removePaper } = useData();
  const [statusFilter, setStatusFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState("updated");
  const [selected, setSelected] = useState(null);
  const [importOpen, setImportOpen] = useState(false);
  const [openExternalError, setOpenExternalError] = useState("");

  const openWithExternalApp = async (paper, chooseApp = true) => {
    if (!paper) return;
    setOpenExternalError("");
    try {
      await openPdfExternal({
        paperId: paper.id || "",
        pdfUrl: paper.pdfUrl || paper.url || "",
        doi: paper.doi || "",
        title: paper.title || "paper",
        chooseApp: Boolean(chooseApp)
      });
    } catch (err) {
      setOpenExternalError(err.message || "无法用外部软件打开 PDF");
    }
  };

  useEffect(() => {
    if (focusPaper) {
      const fresh = library.find((p) => p.id === focusPaper.id) || focusPaper;
      setSelected(fresh);
      onFocusCleared?.();
    }
  }, [focusPaper, library, onFocusCleared]);

  const filtered = useMemo(() => {
    let rows = [...library];
    if (statusFilter !== "all") rows = rows.filter((p) => p.status === statusFilter);
    if (search.trim()) {
      const q = search.toLowerCase();
      rows = rows.filter((p) => `${p.title} ${p.authors?.join(" ")} ${p.venue} ${p.tags?.join(" ")} ${p.notes}`.toLowerCase().includes(q));
    }
    if (sort === "updated") rows.sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0));
    if (sort === "year") rows.sort((a, b) => (b.year || 0) - (a.year || 0));
    if (sort === "understanding") rows.sort((a, b) => (b.understanding || 0) - (a.understanding || 0));
    return rows;
  }, [library, statusFilter, search, sort]);

  const remove = async (p) => {
    if (!window.confirm(`确定从文献库删除「${p.title}」吗？`)) return;
    await removePaper(p.id);
  };

  return (
    <div className="library-page page">
      <section className="page-toolbar">
        <div className="toolbar-left">
          <div className="toolbar-search">
            <Search size={15} />
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="在文献库中筛选..." />
          </div>
          <Segmented options={STATUS_OPTIONS} value={statusFilter} onChange={setStatusFilter} />
          <select className="sort-select" value={sort} onChange={(e) => setSort(e.target.value)}>
            <option value="updated">最近更新</option>
            <option value="year">最新年份</option>
            <option value="understanding">理解等级</option>
          </select>
        </div>
        <Button icon={Plus} onClick={() => setImportOpen(true)}>导入文献</Button>
      </section>

      <ZoteroLibrarySync empty={!library.length} />

      {filtered.length ? (
        <section className="library-table-wrap">
          <div className="library-table">
            <div className="lib-row lib-head">
              <span>论文</span>
              <span>来源 / 年份</span>
              <span>状态</span>
              <span>理解</span>
              <span />
            </div>
            {filtered.map((p) => (
                <div className="lib-row" key={p.id}>
                  <button className="lib-title" onClick={() => setSelected(p)}>
                    <strong>{p.title}</strong>
                    <span>{(p.authors || []).slice(0, 4).join(" · ") || "作者未知"}{p.venue ? ` · ${p.venue}` : ""}</span>
                  </button>
                  <span className="lib-source">
                    <SourceTag source={p.source} label={p.sourceLabel} />
                    {p.year ? <em>{p.year}</em> : null}
                  </span>
                  <span><Badge tone={p.status}>{({ todo: "待读", reading: "在读", understood: "已懂", retold: "已复述" })[p.status]}</Badge></span>
                  <span><Stars value={p.understanding || 1} /></span>
                  <span className="lib-actions">
                    <IconButton icon={FileText} label="打开解读" onClick={() => setSelected(p)} />
                      <IconButton
                        icon={AppWindow}
                        label={p.pdfUrl || p.localPdf ? "内置阅读器" : "内置阅读器 · 尝试获取 PDF"}
                        onClick={() => onReadPdf?.(p.pdfUrl || p.url || "", p.title, p.doi, p.id)}
                      />
                      <IconButton
                        icon={ExternalLink}
                        label="用其他软件打开"
                        onClick={() => openWithExternalApp(p, true)}
                      />
                    <IconButton icon={Trash2} label="删除" onClick={() => remove(p)} />
                  </span>
                </div>
            ))}
          </div>
        </section>
      ) : (
        <EmptyState
          icon={BookOpen}
          title={library.length ? "没有匹配的文献" : "文献库还是空的"}
          desc={library.length ? "调整状态筛选或搜索关键词。" : "从聚合搜索收藏论文，或手动导入 DOI / BibTeX / 中文文献。"}
          action={<Button size="sm" icon={Plus} onClick={() => setImportOpen(true)}>导入文献</Button>}
        />
      )}

      {openExternalError ? (
        <div className="page-banner error" role="alert" style={{ margin: "0 0 12px" }}>
          {openExternalError}
          <button type="button" onClick={() => setOpenExternalError("")} style={{ marginLeft: 12 }}>知道了</button>
        </div>
      ) : null}

      {selected ? (
        <PaperDetail
          paper={selected}
          saved
          onClose={() => setSelected(null)}
          onSave={savePaper}
          onUpdate={(saved) => setSelected(saved)}
          onReadPdf={onReadPdf}
          onOpenPdfExternal={(paper) => openWithExternalApp(paper, true)}
        />
      ) : null}

      {importOpen ? <ImportModal onClose={() => setImportOpen(false)} onImported={async (p) => { await savePaper(p); setImportOpen(false); }} /> : null}
    </div>
  );
}

function ImportModal({ onClose, onImported }) {
  const { meta } = useData();
  const [tab, setTab] = useState("manual");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [manual, setManual] = useState({ title: "", authors: "", year: "", venue: "", abstract: "", url: "", doi: "", keywords: "" });
  const [doi, setDoi] = useState("");
  const [bibtex, setBibtex] = useState("");
  const [pdfData, setPdfData] = useState("");
  const [pdfName, setPdfName] = useState("");
  // PDF 导入可选元数据：DOI / 标题（可由 DOI 解析预填），authors 为解析结果仅用于提交
  const [pdfDoi, setPdfDoi] = useState("");
  const [pdfTitle, setPdfTitle] = useState("");
  const [pdfAuthors, setPdfAuthors] = useState([]);
  const [pdfMetaLoading, setPdfMetaLoading] = useState(false);

  // 按 DOI 补全：调用现有 DOI 导入接口预填标题（并暂存作者供提交使用）
  const resolvePdfMetaByDoi = async () => {
    const doi = pdfDoi.trim();
    if (!doi) return;
    setPdfMetaLoading(true);
    try {
      const paper = await api.post("/api/import", { type: "doi", data: doi });
      if (paper?.title) setPdfTitle(paper.title);
      if (Array.isArray(paper?.authors)) setPdfAuthors(paper.authors);
    } catch {
      /* 解析失败不打断导入流程，PDF 内文识别仍会兜底 */
    } finally {
      setPdfMetaLoading(false);
    }
  };

  const submit = async () => {
    setLoading(true);
    setError("");
    try {
      let paper;
      if (tab === "pdf") {
        if (!pdfData) throw new Error("请先选择 PDF 文件");
        const config = loadAgentConfig();
        paper = await api.importPdf({
          data: pdfData,
          pdfName,
          config,
          // 可选提示字段：服务端会用其覆盖/兜底内文识别结果
          title: pdfTitle.trim() || undefined,
          doi: pdfDoi.trim() || undefined,
          authors: pdfAuthors.length ? pdfAuthors : undefined
        });
      } else if (tab === "doi") {
        paper = await api.post("/api/import", { type: "doi", data: doi });
      } else if (tab === "bibtex") {
        paper = await api.post("/api/import", { type: "bibtex", data: bibtex });
      } else {
        if (!manual.title.trim()) throw new Error("标题不能为空");
        paper = await api.post("/api/import", { type: "manual", data: manual });
      }
      await onImported(paper);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal title="导入文献" onClose={onClose} width="640px">
      <Segmented
        options={[
          { value: "manual", label: "手动录入" },
          { value: "doi", label: "DOI" },
          { value: "bibtex", label: "BibTeX" },
          { value: "pdf", label: "PDF 识别" }
        ]}
        value={tab}
        onChange={setTab}
      />
      {tab === "manual" ? (
        <div className="import-form">
          <label>标题 <input value={manual.title} onChange={(e) => setManual({ ...manual, title: e.target.value })} placeholder="论文标题" /></label>
          <label>作者（逗号分隔） <input value={manual.authors} onChange={(e) => setManual({ ...manual, authors: e.target.value })} placeholder="作者1, 作者2" /></label>
          <div className="two-col">
            <label>年份 <input value={manual.year} onChange={(e) => setManual({ ...manual, year: e.target.value })} placeholder="2024" /></label>
            <label>来源/期刊 <input value={manual.venue} onChange={(e) => setManual({ ...manual, venue: e.target.value })} placeholder="期刊或会议" /></label>
          </div>
          <label>DOI <input value={manual.doi} onChange={(e) => setManual({ ...manual, doi: e.target.value })} placeholder="可选" /></label>
          <TextArea rows={4} value={manual.abstract} onChange={(e) => setManual({ ...manual, abstract: e.target.value })} placeholder="摘要（可选）" />
          <div className="two-col">
            <label>链接 <input value={manual.url} onChange={(e) => setManual({ ...manual, url: e.target.value })} placeholder="https://..." /></label>
            <label>关键词 <input value={manual.keywords} onChange={(e) => setManual({ ...manual, keywords: e.target.value })} placeholder="逗号分隔" /></label>
          </div>
        </div>
      ) : null}
      {tab === "doi" ? (
        <div className="import-form">
          <label>DOI <input value={doi} onChange={(e) => setDoi(e.target.value)} placeholder="例如 10.48550/arXiv.2305.18565" /></label>
          <p className="form-note"><Link2 size={13} /> 输入 DOI 后自动从 Crossref 获取元数据。</p>
        </div>
      ) : null}
      {tab === "bibtex" ? (
        <div className="import-form">
          <TextArea rows={10} value={bibtex} onChange={(e) => setBibtex(e.target.value)} placeholder={`@article{key,\n  title = {Example Paper},\n  author = {Doe, John and Roe, Jane},\n  year = {2024},\n  journal = {Journal},\n  abstract = {...}\n}`} />
          <p className="form-note"><Braces size={13} /> 粘贴完整的 BibTeX 条目，自动解析字段。</p>
        </div>
      ) : null}
      {tab === "pdf" ? (
        <div className="import-form">
          <div className="two-col">
            <label>DOI（可选，自动补全元数据） <input value={pdfDoi} onChange={(e) => setPdfDoi(e.target.value)} placeholder="10.xxxx/xxxxx" /></label>
            <label>按 DOI 补全
              <Button size="sm" variant="ghost" icon={pdfMetaLoading ? Loader2 : Link2} onClick={resolvePdfMetaByDoi} disabled={pdfMetaLoading || !pdfDoi.trim()}>
                {pdfMetaLoading ? "识别中" : "补全标题"}
              </Button>
            </label>
          </div>
          <label>标题（可选） <input value={pdfTitle} onChange={(e) => setPdfTitle(e.target.value)} placeholder="留空则自动从 PDF 内文识别" /></label>
          <label className="pdf-import-picker">
            <FileText size={18} />
            <span>{pdfName || "选择本地 PDF 文件"}</span>
            <input
              type="file"
              accept="application/pdf,.pdf"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                const reader = new FileReader();
                reader.onload = () => {
                  const dataUrl = String(reader.result || "");
                  setPdfData(dataUrl.split(",")[1] || "");
                  setPdfName(file.name);
                };
                reader.readAsDataURL(file);
                e.target.value = "";
              }}
            />
          </label>
          <p className="form-note"><FileText size={13} /> 上传 PDF 后自动提取文字并识别标题、作者、年份、期刊、DOI、摘要与关键词；配置了 Agent 时用 AI 识别，否则用规则兜底。</p>
        </div>
      ) : null}
      <div className="portal-links">
        <span>中文文献：</span>
        {(meta?.chinesePortals || []).map((p) => (
          <button key={p.id} onClick={() => window.open(p.home, "_blank", "noopener")}>{p.label} <ExternalLink size={12} /></button>
        ))}
      </div>
      {error ? <p className="error-text">{error}</p> : null}
      <div className="import-actions">
        <Button variant="ghost" onClick={onClose}>取消</Button>
        <Button icon={loading ? Loader2 : FileText} onClick={submit} disabled={loading}>{loading ? "解析中" : "导入"}</Button>
      </div>
    </Modal>
  );
}

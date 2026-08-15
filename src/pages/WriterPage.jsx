import { useEffect, useRef, useState } from "react";
import { Plus, Save, FileDown, Trash2, ChevronUp, ChevronDown, Quote, FileText, Loader2, BookOpen, PenLine } from "lucide-react";
import { useData } from "../store.jsx";
import { api } from "../api.js";
import { Badge, Button, EmptyState, IconButton, Modal, Segmented, TextArea } from "../components/ui.jsx";

const TEMPLATES = {
  imrad: {
    label: "研究论文",
    sections: [
      { title: "引言", content: "" },
      { title: "相关工作", content: "" },
      { title: "方法", content: "" },
      { title: "实验", content: "" },
      { title: "结论", content: "" }
    ]
  },
  review: {
    label: "综述论文",
    sections: [
      { title: "引言与范围", content: "" },
      { title: "研究现状分类", content: "" },
      { title: "方法比较", content: "" },
      { title: "开放问题", content: "" },
      { title: "结论与展望", content: "" }
    ]
  },
  thesis: {
    label: "学位论文",
    sections: [
      { title: "绪论", content: "" },
      { title: "文献综述", content: "" },
      { title: "研究设计", content: "" },
      { title: "结果与分析", content: "" },
      { title: "讨论与结论", content: "" }
    ]
  }
};

export default function WriterPage() {
  const { drafts, library, saveDraft, deleteDraft } = useData();
  const [currentId, setCurrentId] = useState(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState("");
  const [citationOpen, setCitationOpen] = useState(false);
  const [activeSection, setActiveSection] = useState(0);
  const saveTimer = useRef(null);

  const draft = drafts.find((d) => d.id === currentId) || null;

  useEffect(() => {
    if (!currentId && drafts.length) setCurrentId(drafts[0].id);
  }, [drafts, currentId]);

  const update = (patch) => {
    if (!draft) return;
    saveDraft({ ...draft, ...patch });
    showToast("已保存");
  };

  const scheduleSave = (patch) => {
    if (!draft) return;
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      saveDraft({ ...draft, ...patch }).catch(() => {});
    }, 600);
  };

  const showToast = (msg, error = false) => {
    setToast(msg);
    setTimeout(() => setToast(""), 1800);
  };

  const create = async (type) => {
    setBusy(true);
    try {
      const tpl = TEMPLATES[type];
      const saved = await saveDraft({
        title: `未命名${tpl.label}`,
        type,
        abstract: "",
        sections: tpl.sections.map((s) => ({ ...s })),
        citations: []
      });
      setCurrentId(saved.id);
      setCreateOpen(false);
    } finally {
      setBusy(false);
    }
  };

  const insertCitation = (paper) => {
    if (!draft) return;
    const marker = draft.citations.length + 1;
    const section = draft.sections[activeSection];
    const content = `${section.content}${section.content && !section.content.endsWith(" ") ? " " : ""}[${marker}]`;
    const sections = draft.sections.map((s, i) => (i === activeSection ? { ...s, content } : s));
    update({ sections, citations: [...draft.citations, { paperId: paper.id, marker }] });
    setCitationOpen(false);
    showToast(`已插入引用 [${marker}]`);
  };

  const moveSection = (index, dir) => {
    const sections = [...draft.sections];
    const target = index + dir;
    if (target < 0 || target >= sections.length) return;
    [sections[index], sections[target]] = [sections[target], sections[index]];
    update({ sections });
    setActiveSection(target);
  };

  const removeSection = (index) => {
    const sections = draft.sections.filter((_, i) => i !== index);
    update({ sections });
    if (activeSection >= sections.length) setActiveSection(Math.max(0, sections.length - 1));
  };

  const exportMarkdown = async () => {
    try {
      const text = await api.exportDraft(draft.id);
      const blob = new Blob([text], { type: "text/markdown;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${draft.title.replace(/[\\/:*?"<>|]/g, "_")}.md`;
      a.click();
      URL.revokeObjectURL(url);
      showToast("已导出 Markdown");
    } catch (err) {
      showToast(err.message, true);
    }
  };

  return (
    <div className="page writer-page">
      <div className="writer-layout">
        <aside className="draft-side">
          <div className="draft-side-head">
            <strong>我的草稿</strong>
            <Button size="sm" icon={Plus} onClick={() => setCreateOpen(true)}>新建</Button>
          </div>
          <div className="draft-list">
            {drafts.map((d) => (
              <button key={d.id} className={d.id === currentId ? "active" : ""} onClick={() => setCurrentId(d.id)}>
                <PenLine size={15} />
                <span>
                  <strong>{d.title}</strong>
                  <em>{TEMPLATES[d.type]?.label || d.type} · {new Date(d.updatedAt).toLocaleDateString("zh-CN")}</em>
                </span>
              </button>
            ))}
            {!drafts.length ? <p className="draft-empty">还没有草稿</p> : null}
          </div>
        </aside>

        {draft ? (
          <div className="editor">
            <div className="editor-toolbar">
              <div className="editor-type"><Badge tone="type">{TEMPLATES[draft.type]?.label || "论文"}</Badge></div>
              <div className="editor-actions">
                <Button variant="ghost" size="sm" icon={Quote} onClick={() => setCitationOpen(true)}>插入引用</Button>
                <Button variant="ghost" size="sm" icon={FileDown} onClick={exportMarkdown}>导出 MD</Button>
                <Button size="sm" icon={Save} onClick={() => update({})}>保存</Button>
                <IconButton icon={Trash2} label="删除草稿" onClick={async () => {
                  if (!window.confirm("确定删除这篇草稿吗？")) return;
                  await deleteDraft(draft.id);
                  setCurrentId(null);
                }} />
              </div>
            </div>
            <div className="editor-main">
              <input className="editor-title" value={draft.title} onChange={(e) => scheduleSave({ title: e.target.value })} placeholder="论文标题" />
              <TextArea rows={3} label="摘要" value={draft.abstract} onChange={(e) => scheduleSave({ abstract: e.target.value })} placeholder="用 200-300 字概括研究问题、方法、结果与贡献..." />
              <div className="section-list-editor">
                {draft.sections.map((section, i) => (
                  <section className={`editor-section ${activeSection === i ? "active" : ""}`} key={i}>
                    <div className="editor-section-head" onClick={() => setActiveSection(i)}>
                      <span className="section-index">{String(i + 1).padStart(2, "0")}</span>
                      <input value={section.title} onClick={(e) => e.stopPropagation()} onChange={(e) => {
                        const sections = draft.sections.map((s, si) => (si === i ? { ...s, title: e.target.value } : s));
                        scheduleSave({ sections });
                      }} />
                      <div className="section-tools">
                        <IconButton icon={ChevronUp} label="上移" onClick={(e) => { e.stopPropagation(); moveSection(i, -1); }} />
                        <IconButton icon={ChevronDown} label="下移" onClick={(e) => { e.stopPropagation(); moveSection(i, 1); }} />
                        <IconButton icon={Trash2} label="删除章节" onClick={(e) => { e.stopPropagation(); removeSection(i); }} />
                      </div>
                    </div>
                    {activeSection === i ? (
                      <textarea
                        className="section-content"
                        value={section.content}
                        onChange={(e) => {
                          const sections = draft.sections.map((s, si) => (si === i ? { ...s, content: e.target.value } : s));
                          scheduleSave({ sections });
                        }}
                        placeholder="在这一节写下内容。需要引用时，点击上方“插入引用”。"
                      />
                    ) : null}
                  </section>
                ))}
                <Button variant="ghost" size="sm" icon={Plus} onClick={() => update({ sections: [...draft.sections, { title: "新章节", content: "" }] })}>添加章节</Button>
              </div>
            </div>
          </div>
        ) : (
          <EmptyState icon={FileText} title="选择或创建一篇草稿" desc="从左侧选择草稿，或新建研究论文、综述、学位论文模板。" action={<Button icon={Plus} onClick={() => setCreateOpen(true)}>新建草稿</Button>} />
        )}
      </div>

      {createOpen ? (
        <Modal title="新建论文草稿" onClose={() => setCreateOpen(false)} width="520px">
          <div className="template-grid">
            {Object.entries(TEMPLATES).map(([key, tpl]) => (
              <button key={key} className="template-option" onClick={() => create(key)} disabled={busy}>
                <FileText size={22} />
                <strong>{tpl.label}</strong>
                <span>{tpl.sections.length} 个默认章节，可自由调整</span>
              </button>
            ))}
          </div>
        </Modal>
      ) : null}

      {citationOpen && draft ? (
        <Modal title="插入文献引用" onClose={() => setCitationOpen(false)} width="620px">
          <p className="citation-note">选择一篇文献库论文，引用标记会插入当前章节末尾。引用自动进入文末参考文献。</p>
          <div className="citation-list">
            {library.map((p) => (
              <button key={p.id} onClick={() => insertCitation(p)}>
                <BookOpen size={15} />
                <span>
                  <strong>{p.title}</strong>
                  <em>{(p.authors || []).slice(0, 3).join(" · ")} · {p.year || ""}</em>
                </span>
                <Badge tone="neutral">插入 [{draft.citations.length + 1}]</Badge>
              </button>
            ))}
            {!library.length ? <p className="draft-empty">文献库为空，先去收藏几篇论文。</p> : null}
          </div>
        </Modal>
      ) : null}

      {toast ? <div className="toast">{toast}</div> : null}
    </div>
  );
}

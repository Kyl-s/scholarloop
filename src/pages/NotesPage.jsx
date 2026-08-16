import { useEffect, useState } from "react";
import { Plus, Save, Search, StickyNote, Trash2, X } from "lucide-react";
import { api } from "../api.js";
import { useData } from "../store.jsx";
import ReadingNotesList from "../components/ReadingNotesList.jsx";
import StandaloneNotesList from "../components/StandaloneNotesList.jsx";
import { Badge, Button, SectionHead, Segmented } from "../components/ui.jsx";

const EMPTY_NOTE = { title: "", content: "" };

export default function NotesPage({ onReadPdf }) {
  const { notes, createNote, updateNote, deleteNote } = useData();
  const [tab, setTab] = useState("reading");
  const [items, setItems] = useState([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [draft, setDraft] = useState(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    api.getReadingNotes()
      .then((data) => {
        if (!alive) return;
        setItems(Array.isArray(data) ? data : []);
        setError("");
      })
      .catch((err) => {
        if (!alive) return;
        setError(err.message || "读取手记失败");
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  const openNote = (item, segment) => {
    if (!item.pdfUrl && !item.localPdf) return;
    onReadPdf?.(item.pdfUrl, item.title, item.doi, item.paperId, {
      page: segment?.page || 1,
      tab: "notes"
    });
  };

  const openCreate = () => {
    setTab("free");
    setError("");
    setDraft({ ...EMPTY_NOTE });
  };

  const openEdit = (note) => {
    setTab("free");
    setError("");
    setDraft({ id: note.id, title: note.title || "", content: note.content || "" });
  };

  const saveDraft = async (event) => {
    event.preventDefault();
    if (!String(draft?.title || "").trim() && !String(draft?.content || "").trim()) {
      setError("请填写手记标题或内容");
      return;
    }
    setSaving(true);
    setError("");
    try {
      const payload = { title: draft.title.trim(), content: draft.content };
      if (draft.id) await updateNote(draft.id, payload);
      else await createNote(payload);
      setDraft(null);
    } catch (err) {
      setError(err.message || "保存手记失败");
    } finally {
      setSaving(false);
    }
  };

  const removeDraftNote = async () => {
    if (!draft?.id) {
      setDraft(null);
      return;
    }
    if (!window.confirm(`确定删除「${draft.title || "未命名手记"}」吗？删除后无法恢复。`)) return;
    setError("");
    try {
      await deleteNote(draft.id);
      setDraft(null);
    } catch (err) {
      setError(err.message || "删除手记失败");
    }
  };

  const segmentCount = items.reduce((sum, item) => sum + (item.segments || []).length, 0);
  const countLabel = tab === "reading"
    ? `${items.length} 篇 · ${segmentCount} 段`
    : `${notes.length} 篇`;

  return (
    <div className="page notes-page">
      <SectionHead
        title="手记"
        desc="阅读手记跟着论文走，可跳回原文页；手记自己写，不绑定任何文献。"
        action={<Badge tone="neutral"><StickyNote size={13} /> {countLabel}</Badge>}
      />

      <section className="notes-toolbar">
        <Segmented
          value={tab}
          onChange={setTab}
          options={[
            { value: "reading", label: `阅读手记${items.length ? ` ${items.length}` : ""}` },
            { value: "free", label: `手记${notes.length ? ` ${notes.length}` : ""}` }
          ]}
        />
        <div className="toolbar-search">
          <Search size={15} />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={tab === "reading" ? "按文献、作者或手记内容筛选..." : "按标题或内容筛选..."}
          />
        </div>
        {tab === "free" ? <Button size="sm" icon={Plus} onClick={openCreate}>新建手记</Button> : null}
      </section>

      {error ? <p className="error-text">{error}</p> : null}

      {tab === "reading" ? (
        loading ? <p className="notes-loading">正在读取手记…</p> : (
          <ReadingNotesList
            items={items}
            query={query}
            onOpen={openNote}
            emptyDesc="打开一篇 PDF，在右侧「手记」里写下想法，并用「插入第 N 页」打上定位。写完后这里就能单独打开，也可以在论文写作里插入。"
          />
        )
      ) : (
        <>
          {draft ? (
            <section className="panel standalone-note-editor">
              <div className="standalone-note-editor-head">
                <div>
                  <strong>{draft.id ? "编辑手记" : "新建手记"}</strong>
                  <span>不绑定论文。写完的内容会出现在「手记」列表里，也可以插入论文草稿。</span>
                </div>
                <button type="button" className="memory-close" aria-label="关闭编辑器" onClick={() => setDraft(null)}><X size={17} /></button>
              </div>
              <form onSubmit={saveDraft}>
                <label className="memory-field">
                  <span>标题</span>
                  <input
                    value={draft.title}
                    onChange={(event) => setDraft((current) => ({ ...current, title: event.target.value }))}
                    placeholder="例如：实验假设、下周要补的对照"
                    maxLength={200}
                  />
                </label>
                <label className="memory-field">
                  <span>正文</span>
                  <textarea
                    rows={12}
                    value={draft.content}
                    onChange={(event) => setDraft((current) => ({ ...current, content: event.target.value }))}
                    placeholder="随便写。可以是想法、提纲、会议记录，不必挂在某篇论文上。"
                  />
                </label>
                <div className="standalone-note-editor-actions">
                  {draft.id ? (
                    <Button type="button" variant="ghost" size="sm" icon={Trash2} onClick={removeDraftNote}>删除</Button>
                  ) : null}
                  <Button type="submit" size="sm" icon={Save} disabled={saving}>{saving ? "保存中…" : "保存"}</Button>
                </div>
              </form>
            </section>
          ) : null}
          <StandaloneNotesList
            items={notes}
            query={query}
            selectedId={draft?.id}
            onOpen={openEdit}
            emptyDesc="点「新建手记」写一段不绑定论文的内容。之后也可以在论文写作里插入。"
          />
        </>
      )}
    </div>
  );
}

import { useMemo, useState } from "react";
import { Bookmark, Pencil, Plus, Power, PowerOff, Save, ShieldCheck, Trash2, X } from "lucide-react";
import { useData } from "../store.jsx";
import { Badge, Button, EmptyState, SectionHead } from "../components/ui.jsx";

const EMPTY_DRAFT = { title: "", content: "", tags: "", enabled: true };

function formatUpdatedAt(value) {
  if (!value) return "刚刚";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "刚刚" : date.toLocaleString("zh-CN", { dateStyle: "medium", timeStyle: "short" });
}

export default function MemoryPage() {
  const { memories, createMemory, updateMemory, deleteMemory } = useData();
  const [filter, setFilter] = useState("all");
  const [draft, setDraft] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const visibleMemories = useMemo(() => {
    if (filter === "enabled") return memories.filter((memory) => memory.enabled);
    if (filter === "disabled") return memories.filter((memory) => !memory.enabled);
    return memories;
  }, [filter, memories]);

  const openCreate = () => {
    setError("");
    setNotice("");
    setDraft({ ...EMPTY_DRAFT });
  };

  const openEdit = (memory) => {
    setError("");
    setNotice("");
    setDraft({ ...memory, tags: (memory.tags || []).join(", ") });
  };

  const saveDraft = async (event) => {
    event.preventDefault();
    if (!draft?.content.trim()) {
      setError("请填写记忆内容");
      return;
    }
    setSaving(true);
    setError("");
    try {
      const payload = {
        title: draft.title.trim(),
        content: draft.content.trim(),
        tags: draft.tags,
        enabled: draft.enabled !== false
      };
      if (draft.id) await updateMemory(draft.id, payload);
      else await createMemory(payload);
      setDraft(null);
      setNotice("记忆已保存；API Key、密码和 Cookie 不会被保存");
    } catch (err) {
      setError(err.message || "保存记忆失败");
    } finally {
      setSaving(false);
    }
  };

  const toggleMemory = async (memory) => {
    setError("");
    try {
      await updateMemory(memory.id, { enabled: !memory.enabled });
      setNotice(memory.enabled ? "记忆已停用" : "记忆已启用");
    } catch (err) {
      setError(err.message || "更新记忆失败");
    }
  };

  const removeMemory = async (memory) => {
    if (!window.confirm(`确定删除「${memory.title}」吗？`)) return;
    setError("");
    try {
      await deleteMemory(memory.id);
      setNotice("记忆已删除");
    } catch (err) {
      setError(err.message || "删除记忆失败");
    }
  };

  return (
    <div className="page memory-page">
      <SectionHead
        title="我的记忆"
        desc="独立于 memory-bridge 的 ScholarLoop 个人记忆，只在本机服务于你的科研阅读。"
        action={<Button icon={Plus} onClick={openCreate}>新建记忆</Button>}
      />

      <section className="memory-privacy panel">
        <ShieldCheck size={18} />
        <div>
          <strong>隐私边界</strong>
          <p>记忆保存在本机数据文件中。保存时会自动隐藏 API Key、密码、Token、Cookie 等敏感值；这些内容不会进入 ScholarLoop 记忆。</p>
        </div>
      </section>

      {notice ? <p className="memory-notice">{notice}</p> : null}
      {error ? <p className="error-text">{error}</p> : null}

      {draft ? (
        <section className="panel memory-editor">
          <div className="memory-editor-head">
            <div>
              <strong>{draft.id ? "编辑记忆" : "新建记忆"}</strong>
              <span>只记录对 ScholarLoop 阅读和学习有帮助的长期信息。</span>
            </div>
            <button type="button" className="memory-close" aria-label="关闭编辑器" onClick={() => setDraft(null)}><X size={17} /></button>
          </div>
          <form onSubmit={saveDraft}>
            <label className="memory-field">
              <span>标题</span>
              <input value={draft.title} onChange={(event) => setDraft((current) => ({ ...current, title: event.target.value }))} placeholder="例如：我的研究方向" maxLength={120} />
            </label>
            <label className="memory-field">
              <span>内容</span>
              <textarea value={draft.content} onChange={(event) => setDraft((current) => ({ ...current, content: event.target.value }))} placeholder="例如：我正在研究时间干涉磁刺激，解释论文时先说明基础概念。" rows={6} maxLength={10000} />
            </label>
            <label className="memory-field">
              <span>标签</span>
              <input value={draft.tags} onChange={(event) => setDraft((current) => ({ ...current, tags: event.target.value }))} placeholder="研究方向，阅读偏好" maxLength={300} />
            </label>
            <label className="memory-enabled-toggle">
              <input type="checkbox" checked={draft.enabled !== false} onChange={(event) => setDraft((current) => ({ ...current, enabled: event.target.checked }))} />
              <span>启用这条记忆</span>
            </label>
            <div className="memory-editor-actions">
              <Button type="button" variant="ghost" onClick={() => setDraft(null)}>取消</Button>
              <Button type="submit" icon={Save} disabled={saving}>{saving ? "保存中" : "保存记忆"}</Button>
            </div>
          </form>
        </section>
      ) : null}

      <div className="memory-toolbar">
        <div className="memory-filters" role="tablist" aria-label="记忆筛选">
          {[{ value: "all", label: "全部" }, { value: "enabled", label: "已启用" }, { value: "disabled", label: "已停用" }].map((item) => (
            <button key={item.value} type="button" role="tab" aria-selected={filter === item.value} className={filter === item.value ? "active" : ""} onClick={() => setFilter(item.value)}>{item.label}</button>
          ))}
        </div>
        <span className="memory-count">{visibleMemories.length} 条</span>
      </div>

      {visibleMemories.length ? (
        <div className="memory-list">
          {visibleMemories.map((memory) => (
            <article className={`panel memory-card${memory.enabled ? "" : " disabled"}`} key={memory.id}>
              <div className="memory-card-head">
                <div className="memory-card-title">
                  <Bookmark size={16} />
                  <h3>{memory.title}</h3>
                  <Badge tone={memory.enabled ? "ok" : "neutral"}>{memory.enabled ? "已启用" : "已停用"}</Badge>
                </div>
                <span className="memory-updated">更新于 {formatUpdatedAt(memory.updatedAt)}</span>
              </div>
              <p className="memory-content">{memory.content}</p>
              {memory.tags?.length ? <div className="memory-tags">{memory.tags.map((tag) => <span key={tag}>{tag}</span>)}</div> : null}
              <div className="memory-card-actions">
                <button type="button" onClick={() => openEdit(memory)}><Pencil size={14} /> 编辑</button>
                <button type="button" onClick={() => toggleMemory(memory)}>{memory.enabled ? <PowerOff size={14} /> : <Power size={14} />} {memory.enabled ? "停用" : "启用"}</button>
                <button type="button" className="danger" onClick={() => removeMemory(memory)}><Trash2 size={14} /> 删除</button>
              </div>
            </article>
          ))}
        </div>
      ) : (
        <EmptyState icon={Bookmark} title={filter === "all" ? "还没有 ScholarLoop 记忆" : "没有符合条件的记忆"} desc="把稳定的研究方向、阅读偏好和解释习惯记下来，之后可以随时编辑或停用。" action={filter === "all" ? <Button icon={Plus} onClick={openCreate}>新建第一条记忆</Button> : null} />
      )}
    </div>
  );
}

import { FileText, Pencil, StickyNote } from "lucide-react";
import { excerptNote } from "../readingNotes.js";
import { Badge, Button, EmptyState } from "./ui.jsx";

function formatStamp(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString("zh-CN", { dateStyle: "medium", timeStyle: "short" });
}

export function filterStandaloneNotes(items, query = "") {
  const q = String(query || "").trim().toLowerCase();
  return (items || []).filter((item) => {
    if (!q) return true;
    return `${item.title} ${item.content}`.toLowerCase().includes(q);
  });
}

export default function StandaloneNotesList({
  items,
  query = "",
  selectedId,
  emptyTitle = "还没有手记",
  emptyDesc = "点「新建手记」写一段不绑定论文的内容。",
  onOpen,
  onInsert,
  insertLabel = "插入这篇"
}) {
  const visible = filterStandaloneNotes(items, query);

  if (!visible.length) {
    return <EmptyState icon={StickyNote} title={query.trim() ? "没有匹配的手记" : emptyTitle} desc={query.trim() ? "换个关键词再试试。" : emptyDesc} />;
  }

  return (
    <div className="standalone-notes-list">
      {visible.map((item) => (
        <article className={`panel standalone-note-card ${selectedId === item.id ? "active" : ""}`} key={item.id}>
          <div className="standalone-note-head">
            <div>
              <h3>{item.title || "未命名手记"}</h3>
              <p>{formatStamp(item.updatedAt || item.createdAt)}</p>
            </div>
            <Badge tone="neutral">{String(item.content || "").trim().length} 字</Badge>
          </div>
          <p>{item.content ? excerptNote(item.content, 360) : "（还没有正文）"}</p>
          <div className="standalone-note-actions">
            {onOpen ? (
              <Button type="button" variant="ghost" size="sm" icon={Pencil} onClick={() => onOpen(item)}>
                打开
              </Button>
            ) : null}
            {onInsert ? (
              <Button type="button" size="sm" icon={FileText} onClick={() => onInsert(item)}>
                {insertLabel}
              </Button>
            ) : null}
          </div>
        </article>
      ))}
    </div>
  );
}

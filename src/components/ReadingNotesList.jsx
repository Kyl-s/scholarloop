import { BookOpen, FileText, MapPin, StickyNote } from "lucide-react";
import { excerptNote } from "../readingNotes.js";
import NoteAttachmentThumbs from "./NoteAttachmentThumbs.jsx";
import { Badge, Button, EmptyState } from "./ui.jsx";

function formatStamp(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString("zh-CN", { dateStyle: "medium", timeStyle: "short" });
}

export default function ReadingNotesList({
  items,
  query = "",
  emptyTitle = "还没有阅读手记",
  emptyDesc = "打开一篇 PDF，在右侧「手记」里写下想法，并用「插入第 N 页」打上定位。",
  onOpen,
  onInsert,
  insertLabel = "插入这段"
}) {
  const q = String(query || "").trim().toLowerCase();
  const visible = (items || []).map((item) => {
    const segments = (item.segments || []).filter((segment) => {
      if (!q) return true;
      const hay = `${item.title} ${(item.authors || []).join(" ")} ${segment.content} ${segment.page || ""}`.toLowerCase();
      return hay.includes(q);
    });
    return { ...item, segments };
  }).filter((item) => item.segments.length);

  if (!visible.length) {
    return <EmptyState icon={StickyNote} title={q ? "没有匹配的手记" : emptyTitle} desc={q ? "换个关键词再试试。" : emptyDesc} />;
  }

  return (
    <div className="reading-notes-list">
      {visible.map((item) => (
        <article className="panel reading-note-paper" key={item.paperId}>
          <div className="reading-note-paper-head">
            <div>
              <h3>{item.title}</h3>
              <p>
                {(item.authors || []).slice(0, 3).join(" · ") || "作者未知"}
                {item.year ? ` · ${item.year}` : ""}
                {item.savedAt ? ` · ${formatStamp(item.savedAt)}` : ""}
              </p>
            </div>
            <Badge tone="neutral">{item.segments.length} 段</Badge>
          </div>
          <div className="reading-note-segments">
            {item.segments.map((segment) => (
              <section className="reading-note-segment" key={`${item.paperId}:${segment.id}`}>
                <div className="reading-note-segment-meta">
                  <span>{segment.page ? `第 ${segment.page} 页` : "未标页"}</span>
                  {segment.stamp ? <em>{segment.stamp}</em> : null}
                </div>
                <p>{segment.content ? excerptNote(segment.content, 360) : "（仅页码标记，尚无文字）"}</p>
                <NoteAttachmentThumbs text={segment.content} />
                <div className="reading-note-segment-actions">
                  {onOpen ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      icon={segment.page ? MapPin : BookOpen}
                      disabled={!item.pdfUrl && !item.localPdf}
                      onClick={() => onOpen(item, segment)}
                    >
                      {segment.page ? "打开原文此处" : "打开文献"}
                    </Button>
                  ) : null}
                  {onInsert ? (
                    <Button type="button" size="sm" icon={FileText} onClick={() => onInsert(item, segment)}>
                      {insertLabel}
                    </Button>
                  ) : null}
                </div>
              </section>
            ))}
          </div>
        </article>
      ))}
    </div>
  );
}

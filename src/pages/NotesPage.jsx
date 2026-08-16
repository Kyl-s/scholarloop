import { useEffect, useState } from "react";
import { Search, StickyNote } from "lucide-react";
import { api } from "../api.js";
import ReadingNotesList from "../components/ReadingNotesList.jsx";
import { Badge, SectionHead } from "../components/ui.jsx";

export default function NotesPage({ onReadPdf }) {
  const [items, setItems] = useState([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

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

  const segmentCount = items.reduce((sum, item) => sum + (item.segments || []).length, 0);

  return (
    <div className="page notes-page">
      <SectionHead
        title="阅读手记"
        desc="不必先打开 PDF。按文献浏览随读写下的手记，点一段就能跳回原文对应页。"
        action={<Badge tone="neutral"><StickyNote size={13} /> {items.length} 篇 · {segmentCount} 段</Badge>}
      />

      <section className="notes-toolbar">
        <div className="toolbar-search">
          <Search size={15} />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="按文献、作者或手记内容筛选..." />
        </div>
      </section>

      {error ? <p className="error-text">{error}</p> : null}
      {loading ? <p className="notes-loading">正在读取手记…</p> : (
        <ReadingNotesList
          items={items}
          query={query}
          onOpen={openNote}
          emptyDesc="打开一篇 PDF，在右侧「手记」里写下想法，并用「插入第 N 页」打上定位。写完后这里就能单独打开，也可以在论文写作里插入。"
        />
      )}
    </div>
  );
}

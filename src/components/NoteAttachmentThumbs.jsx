import { useState } from "react";
import { BookOpen, FileText } from "lucide-react";
import { parseNoteAttachments } from "../noteAttachments.js";
import MarkdownNoteReader, { MarkdownOpenChooser } from "./MarkdownNoteReader.jsx";

export default function NoteAttachmentThumbs({ text, limit = 4 }) {
  const items = parseNoteAttachments(text).slice(0, limit);
  const [chooserItem, setChooserItem] = useState(null);
  const [readerItem, setReaderItem] = useState(null);
  if (!items.length) return null;
  return (
    <>
      <div className="note-attach-thumbs">
        {items.map((item) => {
          const isMarkdown = item.name.toLowerCase().endsWith(".md");
          if (item.kind === "image") {
            return <a key={item.id} className="note-attach-thumb" href={item.url} target="_blank" rel="noreferrer" title={item.name}>
              <img src={item.url} alt={item.name} />
            </a>;
          }
          if (isMarkdown) {
            return <button key={item.id} type="button" className="note-attach-file note-attach-file-button" title="选择打开方式" onClick={() => setChooserItem(item)}>
              <BookOpen size={13} />
              <span>{item.name}</span>
            </button>;
          }
          return <a key={item.id} className="note-attach-file" href={item.url} target="_blank" rel="noreferrer" title={item.name}>
            <FileText size={13} />
            <span>{item.name}</span>
          </a>;
        })}
      </div>
      <MarkdownOpenChooser item={chooserItem} onClose={() => setChooserItem(null)} onRead={(item) => { setChooserItem(null); setReaderItem(item); }} />
      <MarkdownNoteReader item={readerItem} onClose={() => setReaderItem(null)} />
    </>
  );
}

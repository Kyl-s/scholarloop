import { FileText } from "lucide-react";
import { parseNoteAttachments } from "../noteAttachments.js";

export default function NoteAttachmentThumbs({ text, limit = 4 }) {
  const items = parseNoteAttachments(text).slice(0, limit);
  if (!items.length) return null;
  return (
    <div className="note-attach-thumbs">
      {items.map((item) => (
        item.kind === "image" ? (
          <a key={item.id} className="note-attach-thumb" href={item.url} target="_blank" rel="noreferrer" title={item.name}>
            <img src={item.url} alt={item.name} />
          </a>
        ) : (
          <a key={item.id} className="note-attach-file" href={item.url} target="_blank" rel="noreferrer" title={item.name}>
            <FileText size={13} />
            <span>{item.name}</span>
          </a>
        )
      ))}
    </div>
  );
}

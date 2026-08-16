import { useRef, useState } from "react";
import { ImagePlus, Paperclip } from "lucide-react";
import { api } from "../api.js";
import { fileToBase64 } from "../noteAttachments.js";
import { Button } from "./ui.jsx";

export default function NoteAttachBar({ onInsert, onError, compact = false }) {
  const imageRef = useRef(null);
  const fileRef = useRef(null);
  const [busy, setBusy] = useState(false);

  const uploadFiles = async (files) => {
    const list = [...(files || [])].filter(Boolean);
    if (!list.length) return;
    setBusy(true);
    try {
      for (const file of list) {
        const data = await fileToBase64(file);
        const saved = await api.uploadNoteFile({
          name: file.name || "未命名文件",
          mime: file.type || "",
          data
        });
        onInsert?.(saved.token.endsWith("\n") ? saved.token : `${saved.token}\n`);
      }
    } catch (err) {
      onError?.(err.message || "插入附件失败");
    } finally {
      setBusy(false);
      if (imageRef.current) imageRef.current.value = "";
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  return (
    <div className={`note-attach-bar ${compact ? "compact" : ""}`}>
      <input
        ref={imageRef}
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp"
        hidden
        onChange={(event) => uploadFiles(event.target.files)}
      />
      <input
        ref={fileRef}
        type="file"
        accept=".pdf,.txt,.md,.csv,.tsv,.json,.bib,.ris,.xlsx,.xls,.docx,.doc,.pptx,.ppt,.zip,.7z,image/png,image/jpeg,image/gif,image/webp"
        hidden
        onChange={(event) => uploadFiles(event.target.files)}
      />
      {compact ? (
        <>
          <button type="button" disabled={busy} onClick={() => imageRef.current?.click()} title="插入图片">
            {busy ? "插入中…" : "插入图片"}
          </button>
          <button type="button" disabled={busy} onClick={() => fileRef.current?.click()} title="插入文件">
            插入文件
          </button>
        </>
      ) : (
        <>
          <Button type="button" variant="ghost" size="sm" icon={ImagePlus} disabled={busy} onClick={() => imageRef.current?.click()}>
            {busy ? "插入中…" : "插入图片"}
          </Button>
          <Button type="button" variant="ghost" size="sm" icon={Paperclip} disabled={busy} onClick={() => fileRef.current?.click()}>
            插入文件
          </Button>
        </>
      )}
    </div>
  );
}

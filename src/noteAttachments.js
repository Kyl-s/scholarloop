const TOKEN_RE = /(!?)\[([^\]]*)\]\(\/api\/note-files\/([0-9a-f-]{36})\)/gi;

export function parseNoteAttachments(text) {
  const items = [];
  String(text || "").replace(TOKEN_RE, (raw, bang, name, id) => {
    items.push({
      raw,
      id,
      name: String(name || "").trim() || "未命名文件",
      url: `/api/note-files/${id}`,
      kind: bang === "!" ? "image" : "file"
    });
    return raw;
  });
  return items;
}

export function stripNoteAttachments(text) {
  return String(text || "").replace(TOKEN_RE, "").replace(/[ \t]+\n/g, "\n").trim();
}

export function insertAtCursor(value, token, start, end) {
  const text = String(value || "");
  const from = Number.isInteger(start) ? start : text.length;
  const to = Number.isInteger(end) ? end : from;
  const chunk = String(token || "");
  const next = `${text.slice(0, from)}${chunk}${text.slice(to)}`;
  return { next, caret: from + chunk.length };
}

export function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || "");
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(new Error("读取文件失败"));
    reader.readAsDataURL(file);
  });
}

export function pastedFiles(event) {
  const files = [];
  const list = event?.clipboardData?.files;
  if (list?.length) {
    for (const file of list) files.push(file);
    return files;
  }
  const items = event?.clipboardData?.items;
  if (!items) return files;
  for (const item of items) {
    if (item.kind !== "file") continue;
    const file = item.getAsFile();
    if (file) files.push(file);
  }
  return files;
}

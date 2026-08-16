const PAGE_MARKER = /——\s*第\s*(\d+)\s*页(?:\s*·\s*([^—\n]+))?\s*——/g;

export function parseReadingNotes(text) {
  const source = String(text || "");
  if (!source.trim()) return [];

  const matches = [...source.matchAll(PAGE_MARKER)];
  if (!matches.length) {
    return [{ id: "all", page: null, stamp: "", content: source.trim() }];
  }

  const segments = [];
  const lead = source.slice(0, matches[0].index).trim();
  if (lead) {
    segments.push({ id: "lead", page: null, stamp: "", content: lead });
  }

  matches.forEach((match, index) => {
    const start = match.index + match[0].length;
    const end = index + 1 < matches.length ? matches[index + 1].index : source.length;
    const content = source.slice(start, end).trim();
    const page = Number(match[1]) || null;
    const stamp = String(match[2] || "").trim();
    if (!content && !page) return;
    segments.push({
      id: `p${page || 0}-${index}`,
      page,
      stamp,
      content
    });
  });

  return segments;
}

export function excerptNote(text, max = 140) {
  const value = String(text || "").replace(/\s+/g, " ").trim();
  if (!value) return "";
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

export function formatNoteForWriter({ title, page, content } = {}) {
  const loc = page ? `第 ${page} 页` : "未标页";
  const head = `【手记 · ${title || "文献"} · ${loc}】`;
  const body = String(content || "").trim();
  return body ? `${head}\n${body}` : head;
}

export function collectNotePages(segments) {
  const pages = [];
  for (const segment of segments || []) {
    const page = Number(segment?.page);
    if (!page || pages.includes(page)) continue;
    pages.push(page);
  }
  return pages;
}

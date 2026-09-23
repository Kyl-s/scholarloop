function pageMarkerRegex() {
  return /——\s*第\s*(\d+)\s*页(?:\s*·\s*([^—\n]+))?\s*——/g;
}

export function formatPageMarker(page, stamp) {
  const pageNum = Number(page) || 1;
  const when = String(stamp || "").trim();
  return when ? `—— 第 ${pageNum} 页 · ${when} ——` : `—— 第 ${pageNum} 页 ——`;
}

export function serializeReadingNotes(segments) {
  const blocks = [];
  for (const segment of segments || []) {
    const content = String(segment?.content || "").trim();
    if (segment?.page) {
      const head = formatPageMarker(segment.page, segment.stamp);
      blocks.push(content ? `${head}\n${content}` : head);
    } else if (content) {
      blocks.push(content);
    }
  }
  return blocks.length ? `${blocks.join("\n\n")}\n` : "";
}

function mergeReadingNoteSegments(segments) {
  const merged = [];
  for (const segment of segments || []) {
    const page = Number(segment?.page) || null;
    const content = String(segment?.content || "").trim();
    const stamp = String(segment?.stamp || "").trim();
    const existing = merged.find((item) => (Number(item.page) || null) === page);
    if (!existing) {
      merged.push({
        id: page ? `p${page}` : "document",
        page,
        stamp,
        content
      });
      continue;
    }
    if (content) existing.content = existing.content ? `${existing.content}\n\n${content}` : content;
    if (!existing.stamp && stamp) existing.stamp = stamp;
  }
  return merged;
}

export function normalizeReadingNotes(text) {
  const source = String(text || "");
  if (!source.trim()) return "";
  return serializeReadingNotes(parseReadingNotes(source));
}

export function readReadingNotes(text) {
  const segments = parseReadingNotes(text);
  const documentSegment = segments.find((segment) => !segment.page);
  return {
    document: documentSegment?.content || "",
    pages: segments
      .filter((segment) => segment.page)
      .map((segment) => ({
        page: Number(segment.page),
        stamp: segment.stamp || "",
        content: segment.content || ""
      }))
  };
}

export function getReadingNoteContent(text, scope = "page", page) {
  const notes = readReadingNotes(text);
  if (scope === "document") return notes.document;
  const pageNumber = Number(page) || 0;
  return notes.pages.find((segment) => segment.page === pageNumber)?.content || "";
}

export function updateReadingNote(text, { scope = "page", page, content = "", stamp = "" } = {}) {
  const segments = parseReadingNotes(text);
  const pageNumber = Number(page) || 0;
  const nextContent = String(content || "").trim();
  const targetPage = scope === "document" ? null : pageNumber;
  const index = segments.findIndex((segment) => (Number(segment.page) || null) === targetPage);

  if (!nextContent && scope !== "document") {
    if (index >= 0) segments.splice(index, 1);
    return serializeReadingNotes(segments);
  }

  if (index >= 0) {
    segments[index] = {
      ...segments[index],
      content: nextContent,
      stamp: segments[index].stamp || (scope === "document" ? "" : String(stamp || "").trim())
    };
  } else if (nextContent) {
    const nextSegment = {
      id: targetPage ? `p${targetPage}` : "document",
      page: targetPage,
      stamp: targetPage ? String(stamp || "").trim() : "",
      content: nextContent
    };
    if (targetPage) segments.push(nextSegment);
    else segments.unshift(nextSegment);
  }
  return serializeReadingNotes(segments);
}

export function caretAfterLeadingMarker(text) {
  const source = String(text || "");
  const newline = source.indexOf("\n");
  return newline === -1 ? source.length : newline + 1;
}

export function insertPageMarker(text, page, stamp) {
  const marker = formatPageMarker(page, stamp);
  const normalized = normalizeReadingNotes(text).replace(/\s+$/, "");
  if (!normalized.trim()) return `${marker}\n`;

  const matches = [...normalized.matchAll(pageMarkerRegex())];
  if (!matches.length) {
    // 先写后标页：标记一律放文首，后面才是这一页的正文
    return `${marker}\n${normalized}\n`;
  }

  // 再标一页：新标记仍加在文首，旧页整段下移
  return `${marker}\n\n${normalized}\n`;
}

function parseReadingNoteSegments(text) {
  const source = String(text || "");
  if (!source.trim()) return [];

  const matches = [...source.matchAll(pageMarkerRegex())];
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

  // 先写后标页时标记在文末，第一个页标记是空的：把前言归到这一页
  if (
    segments.length >= 2
    && !segments[0].page
    && segments[0].content
    && segments[1].page
    && !segments[1].content
  ) {
    segments[1] = { ...segments[1], content: segments[0].content };
    segments.shift();
  }

  return segments;
}

export function parseReadingNotes(text) {
  return mergeReadingNoteSegments(parseReadingNoteSegments(text));
}

export function excerptNote(text, max = 140) {
  const value = String(text || "")
    .replace(/(!?)\[([^\]]*)\]\(\/api\/note-files\/[0-9a-f-]{36}\)/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!value) return "";
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

export function formatNoteForWriter({ title, page, content, kind } = {}) {
  const body = String(content || "").trim();
  if (kind === "standalone") {
    const head = `【手记 · ${title || "未命名手记"}】`;
    return body ? `${head}\n${body}` : head;
  }
  const loc = page ? `第 ${page} 页` : "未标页";
  const head = `【手记 · ${title || "文献"} · ${loc}】`;
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

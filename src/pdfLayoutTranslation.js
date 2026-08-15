const LAYOUT_TOKEN = /__SCHOLARLOOP_KEEP_(\d+)__/g;

export function buildLayoutTranslationPrompt(lines) {
  return (Array.isArray(lines) ? lines : [])
    .map((line, index) => `__SCHOLARLOOP_KEEP_${index}__\n${String(line?.text || "").trim()}`)
    .filter((line) => line.split("\n").at(-1))
    .join("\n");
}

function cleanSegment(value) {
  return String(value || "")
    .replace(/__SCHOLARLOOP_KEEP_\d__/g, "")
    .replace(/^\s+|\s+$/g, "")
    .trim();
}

function distributeFallbackText(source, lines) {
  const expected = Array.isArray(lines) ? lines : [];
  const text = String(source || "").trim();
  if (!text || !expected.length) return [];
  const totalWeight = expected.reduce((sum, line) => sum + Math.max(1, String(line?.text || "").length), 0);
  let cursor = 0;
  let remainingWeight = totalWeight;
  return expected.map((line, index) => {
    if (index === expected.length - 1) return text.slice(cursor).trim();
    const remaining = text.length - cursor;
    const weight = Math.max(1, String(line?.text || "").length);
    const size = Math.max(1, Math.round((remaining * weight) / Math.max(1, remainingWeight)));
    const value = text.slice(cursor, Math.min(text.length, cursor + size)).trim();
    cursor += size;
    remainingWeight -= weight;
    return value;
  });
}

export function parseLayoutTranslation(output, lines) {
  const source = String(output || "").trim();
  const expected = Array.isArray(lines) ? lines : [];
  const matches = [...source.matchAll(LAYOUT_TOKEN)].sort((a, b) => Number(a[1]) - Number(b[1]));
  const translated = new Map();
  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    const lineIndex = Number(match[1]);
    const next = matches[index + 1];
    const value = source.slice(match.index + match[0].length, next ? next.index : source.length);
    if (Number.isInteger(lineIndex) && lineIndex >= 0 && lineIndex < expected.length) translated.set(lineIndex, cleanSegment(value));
  }

  if (!matches.length || translated.size < expected.length) {
    const fallback = source
      .replace(LAYOUT_TOKEN, "")
      .split(/\r?\n+/)
      .map(cleanSegment)
      .filter(Boolean);
    if (fallback.length >= expected.length) {
      fallback.slice(0, expected.length).forEach((value, index) => translated.set(index, value));
    } else {
      distributeFallbackText(fallback.join(" "), expected).forEach((value, index) => translated.set(index, value));
    }
  }

  return expected
    .map((line, index) => ({ ...line, text: cleanSegment(translated.get(index)) }))
    .filter((line) => line.text);
}

export function joinLayoutTranslation(lines) {
  return (Array.isArray(lines) ? lines : [])
    .map((line) => String(line?.text || "").trim())
    .filter(Boolean)
    .join("\n");
}

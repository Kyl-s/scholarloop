const LAYOUT_TOKEN = /__SCHOLARLOOP_KEEP_(\d+)__/g;

export function buildLayoutTranslationPrompt(lines) {
  return (Array.isArray(lines) ? lines : [])
    .map((line, index) => `__SCHOLARLOOP_KEEP_${index}__\n${String(line?.text || "").trim()}`)
    .filter((line) => line.split("\n").at(-1))
    .join("\n");
}

export function cleanLayoutTranslationText(value) {
  return String(value || "").replace(/__SCHOLARLOOP_KEEP_\d+__/g, "").trim();
}

export function parseLayoutTranslation(output, lines) {
  const source = String(output || "").trim();
  const expected = Array.isArray(lines) ? lines : [];
  // Slice in response order, then map by token ID. Sorting first corrupts
  // boundaries when a model returns IDs out of order (including IDs >= 10).
  const matches = [...source.matchAll(LAYOUT_TOKEN)];
  const translated = new Map();
  let invalid = false;
  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    const lineIndex = Number(match[1]);
    const next = matches[index + 1];
    const value = cleanLayoutTranslationText(source.slice(match.index + match[0].length, next ? next.index : source.length));
    if (lineIndex >= expected.length || translated.has(lineIndex) || !value) invalid = true;
    else translated.set(lineIndex, value);
  }
  // Never invent spatial alignment from line count or character proportions.
  if (invalid || !expected.length || translated.size !== expected.length) return [];
  return expected.map((line, index) => ({ ...line, text: translated.get(index) }));
}

export function joinLayoutTranslation(lines) {
  return (Array.isArray(lines) ? lines : [])
    .map((line) => String(line?.text || "").trim())
    .filter(Boolean)
    .join("\n");
}

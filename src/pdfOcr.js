export const OCR_LANGUAGES = "eng+chi_sim";
export const OCR_CORE_PATH = "https://cdn.jsdelivr.net/npm/tesseract.js-core@v7.0.0";

let workerPromise = null;
let progressListener = null;

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function collectProtectedSegments(text) {
  const patterns = [
    /\$\$[\s\S]*?\$\$/g,
    /(?<!\w)\$[^$\n]{1,240}\$(?!\w)/g,
    /\\\([\s\S]*?\\\)/g,
    /\\\[[\s\S]*?\\\]/g,
    /^\s*[A-Za-zΑ-Ωα-ω][A-Za-z0-9_{}^()]*\s*(?:=|≈|≤|≥|<|>|∑|∫|√|±|×)\s*[^\n]{1,180}$/gm,
    /(?<!\w)\[(?:\d+(?:\s*[-,;]\s*\d+)*)\](?!\w)/g,
    /(?<!\w)\((?:\d+[a-z]?(?:\s*[-,;]\s*\d+)*)\)(?!\w)/gi,
    /(?<!\w)(?:fig(?:ure)?|table|eq(?:uation)?)[.\s]*\(?\d+[a-z]?\)?/gi
  ];
  const found = [];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const value = match[0];
      const start = match.index ?? -1;
      if (start < 0 || !value.trim()) continue;
      found.push({ start, end: start + value.length, value });
    }
  }
  return found
    .sort((a, b) => a.start - b.start || b.end - a.end)
    .filter((item, index, all) => index === 0 || item.start >= all[index - 1].end);
}

export function normalizeOcrText(value, maxLength = 12000) {
  return String(value || "")
    .replace(/\u0000/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, maxLength);
}

export function protectOcrText(value) {
  const source = normalizeOcrText(value);
  if (!source) return { text: "", tokens: [] };
  const segments = collectProtectedSegments(source);
  if (!segments.length) return { text: source, tokens: [] };

  const tokens = [];
  let cursor = 0;
  let text = "";
  for (const segment of segments) {
    if (segment.start < cursor) continue;
    text += source.slice(cursor, segment.start);
    const token = `__SCHOLARLOOP_KEEP_${tokens.length}__`;
    tokens.push({ token, value: segment.value });
    text += token;
    cursor = segment.end;
  }
  text += source.slice(cursor);
  return { text, tokens };
}

export function restoreProtectedText(value, tokens = []) {
  let output = String(value || "");
  for (const item of Array.isArray(tokens) ? tokens : []) {
    const token = String(item?.token || "");
    if (!token) continue;
    output = output.replace(new RegExp(escapeRegExp(token), "g"), String(item.value || ""));
  }
  return output;
}

export function normalizeOcrBox(box) {
  if (!box) return null;
  const left = Math.min(Number(box.left) || 0, Number(box.right) || 0);
  const right = Math.max(Number(box.left) || 0, Number(box.right) || 0);
  const top = Math.min(Number(box.top) || 0, Number(box.bottom) || 0);
  const bottom = Math.max(Number(box.top) || 0, Number(box.bottom) || 0);
  const width = Number((right - left).toFixed(4));
  const height = Number((bottom - top).toFixed(4));
  if (width < 0.01 || height < 0.01) return null;
  return { left, top, right, bottom, width, height };
}

export function ocrRegionCacheKey(page, box) {
  const normalized = normalizeOcrBox(box);
  if (!normalized) return "";
  const round = (value) => Number(value.toFixed(4));
  return `p${Number(page) || 0}:${round(normalized.left)},${round(normalized.top)},${round(normalized.width)},${round(normalized.height)}`;
}

export async function recognizeOcrImage(image, onProgress) {
  if (!workerPromise) {
    workerPromise = (async () => {
      const [{ createWorker }, { default: workerUrl }] = await Promise.all([
        import("tesseract.js"),
        import("tesseract.js/dist/worker.min.js?url")
      ]);
      return createWorker(OCR_LANGUAGES, 1, {
        workerPath: workerUrl,
        corePath: OCR_CORE_PATH,
        cacheMethod: "write",
        logger: (message) => progressListener?.(message)
      });
    })().catch((error) => {
      workerPromise = null;
      throw error;
    });
  }
  const worker = await workerPromise;
  progressListener = onProgress;
  try {
    const result = await worker.recognize(image, { preserve_interword_spaces: "1" });
    return {
      text: normalizeOcrText(result?.data?.text),
      confidence: Number(result?.data?.confidence) || 0,
      words: Array.isArray(result?.data?.words) ? result.data.words : []
    };
  } finally {
    progressListener = null;
  }
}

export function resetOcrWorker() {
  workerPromise = null;
}

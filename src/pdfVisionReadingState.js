// Source objects are weakly held; results live only in this renderer's memory.
const sourceCaches = new WeakMap();

export function visionModelIdentity(config) {
  return JSON.stringify([
    String(config?.provider || config?.providerName || config?.name || ""),
    String(config?.baseUrl || "").trim().replace(/\/+$/, ""),
    String(config?.model || "").trim()
  ]);
}

export function visionResultsFor(source, identity) {
  if (!source) return new Map();
  let models = sourceCaches.get(source);
  if (!models) { models = new Map(); sourceCaches.set(source, models); }
  if (!models.has(identity)) models.set(identity, new Map());
  return models.get(identity);
}

export function parseVisionPages(value, total) {
  if (!String(value).trim()) return { pages: [], error: "请输入页码，例如 1-5,8。" };
  const pages = new Set();
  for (const part of String(value).replace(/，/g, ",").split(",")) {
    const match = part.trim().match(/^(\d+)\s*(?:-\s*(\d+))?$/);
    if (!match) return { pages: [], error: "页码格式不正确，请使用 1-5,8 这样的格式。" };
    const start = Number(match[1]);
    const end = Number(match[2] || match[1]);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start || end > total) {
      return { pages: [], error: `页码须在 1–${total} 内，且范围起始页不能大于结束页。` };
    }
    for (let page = start; page <= end; page += 1) pages.add(page);
  }
  return { pages: [...pages].sort((a, b) => a - b), error: "" };
}

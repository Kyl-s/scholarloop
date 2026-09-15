const HTTP_PROTOCOLS = new Set(["http:", "https:"]);

/**
 * Return a normalized URL only when it is safe to load in the embedded browser.
 * Keeping this check in a UI-independent module makes it usable for both typed
 * addresses and Electron's window-open events.
 */
export function normalizeBrowserUrl(value) {
  if (value instanceof URL) {
    if (!HTTP_PROTOCOLS.has(value.protocol)) return "";
    return value.toString();
  }

  const source = String(value ?? "").trim();
  if (!source) return "";

  try {
    const url = new URL(source);
    return HTTP_PROTOCOLS.has(url.protocol) ? url.toString() : "";
  } catch {
    return "";
  }
}

export function isSafeBrowserUrl(value) {
  return Boolean(normalizeBrowserUrl(value));
}

function tabIdForUrl(url) {
  // The URL is intentionally deterministic: repeated requests for the same
  // popup can focus an existing tab without introducing random state.
  return `browser-${url}`;
}

function normalizeTitle(value) {
  return String(value ?? "").trim();
}

/**
 * Build a tab value. Invalid URLs return null so callers can ignore unsafe
 * popup requests without needing exception handling in a render path.
 */
export function createBrowserTab({
  id,
  url,
  title = "",
  siteId = "",
  closable = true,
  ...rest
} = {}) {
  const normalizedUrl = normalizeBrowserUrl(url);
  if (!normalizedUrl) return null;

  return {
    ...rest,
    id: String(id || tabIdForUrl(normalizedUrl)),
    url: normalizedUrl,
    title: normalizeTitle(title),
    siteId: String(siteId || ""),
    closable: closable !== false
  };
}

function sameTab(a, b) {
  return a.id === b.id || a.url === b.url;
}

function cloneState(state) {
  return {
    tabs: Array.isArray(state?.tabs) ? state.tabs.slice() : [],
    activeId: state?.activeId || null
  };
}

/** Build an empty, still-safe tab that can be used as a browser-like new tab page. */
export function createBlankBrowserTab({ id, title = "新标签", closable = true, ...rest } = {}) {
  return {
    ...rest,
    id: String(id || "blank-" + Date.now()),
    url: "",
    title: normalizeTitle(title) || "新标签",
    siteId: "blank",
    closable: closable !== false,
    blank: true
  };
}

/** Create a normalized, deduplicated tab state for the embedded browser. */
export function createBrowserTabState(initialTabs = [], activeId = null) {
  const tabs = [];
  for (const candidate of Array.isArray(initialTabs) ? initialTabs : []) {
    const tab = candidate?.url ? createBrowserTab(candidate) : null;
    if (!tab || tabs.some((existing) => sameTab(existing, tab))) continue;
    tabs.push(tab);
  }

  const requestedId = String(activeId || "");
  return {
    tabs,
    activeId: tabs.some((tab) => tab.id === requestedId) ? requestedId : (tabs[0]?.id || null)
  };
}

export function focusBrowserTab(state, id) {
  const next = cloneState(state);
  const targetId = String(id || "");
  if (next.tabs.some((tab) => tab.id === targetId)) next.activeId = targetId;
  return next;
}

/**
 * Add a tab, or update/focus the existing tab with the same id or URL.
 * `activate: false` is useful when restoring a tab in the background.
 */
export function upsertBrowserTab(state, candidate, { activate = true } = {}) {
  const tab = candidate?.url ? createBrowserTab(candidate) : null;
  if (!tab) return cloneState(state);

  const next = cloneState(state);
  const index = next.tabs.findIndex((existing) => sameTab(existing, tab));
  if (index === -1) {
    next.tabs.push(tab);
  } else {
    // Preserve the existing id and non-transient tab attributes while taking
    // the newest URL/title from the navigation event.
    next.tabs[index] = { ...next.tabs[index], ...tab, id: next.tabs[index].id };
  }
  if (activate) next.activeId = index === -1 ? tab.id : next.tabs[index].id;
  if (!next.activeId || !next.tabs.some((item) => item.id === next.activeId)) {
    next.activeId = next.tabs[0]?.id || null;
  }
  return next;
}

/** Close a tab and select its previous neighbour, or next neighbour at index 0. */
export function closeBrowserTab(state, id) {
  const next = cloneState(state);
  const index = next.tabs.findIndex((tab) => tab.id === String(id || ""));
  if (index === -1 || next.tabs[index].closable === false) return next;

  const wasActive = next.activeId === next.tabs[index].id;
  next.tabs.splice(index, 1);
  if (wasActive) {
    next.activeId = next.tabs[Math.max(0, index - 1)]?.id || next.tabs[0]?.id || null;
  } else if (!next.tabs.some((tab) => tab.id === next.activeId)) {
    next.activeId = next.tabs[0]?.id || null;
  }
  return next;
}

/** Update navigation metadata; an unsafe URL update is rejected atomically. */
export function updateBrowserTab(state, id, patch = {}) {
  const next = cloneState(state);
  const originalId = String(id || "");
  const index = next.tabs.findIndex((tab) => tab.id === originalId);
  if (index === -1) return next;

  if (Object.prototype.hasOwnProperty.call(patch, "url")) {
    const normalizedUrl = normalizeBrowserUrl(patch.url);
    if (!normalizedUrl) return next;
    next.tabs[index] = { ...next.tabs[index], ...patch, url: normalizedUrl };
  } else {
    next.tabs[index] = { ...next.tabs[index], ...patch };
  }
  if (Object.prototype.hasOwnProperty.call(patch, "title")) {
    next.tabs[index].title = normalizeTitle(patch.title);
  }
  if (Object.prototype.hasOwnProperty.call(patch, "id")) {
    // Tab ids are state keys and must not be changed through metadata updates.
    next.tabs[index].id = originalId;
  }
  return next;
}

export function getBrowserTabLabel(tab) {
  const title = normalizeTitle(tab?.title);
  if (title) return title;
  try {
    return new URL(tab?.url).hostname || "新标签";
  } catch {
    return "新标签";
  }
}

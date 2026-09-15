import { getProxyUrl, fetchWithFallback } from "./proxy.js";

const SHARE_HOSTS = new Set(["chatgpt.com", "www.chatgpt.com", "chat.openai.com", "www.chat.openai.com"]);
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const FETCH_TIMEOUT = 20000;
const USER_AGENT = "ScholarLoop/1.1 (ChatGPT shared conversation import)";

function allowedHost(value) {
  const url = value instanceof URL ? value : new URL(value);
  return SHARE_HOSTS.has(url.hostname.toLowerCase());
}

export function parseChatGptShareUrl(value) {
  const raw = String(value || "").trim();
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("请输入有效的 ChatGPT 分享链接");
  }
  if (url.protocol !== "https:" || !allowedHost(url)) {
    throw new Error("目前只支持 ChatGPT 的 HTTPS 分享链接");
  }
  const match = url.pathname.match(/^\/share\/([A-Za-z0-9_-]{8,128})\/?$/);
  if (!match) {
    throw new Error("目前只支持 ChatGPT 的公开 /share/ 分享链接，不支持私有对话链接");
  }
  url.hash = "";
  return { url: url.toString(), shareId: match[1] };
}

function textFromContent(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(textFromContent).filter(Boolean).join("\n");
  if (!value || typeof value !== "object") return "";
  if (Array.isArray(value.parts)) return textFromContent(value.parts);
  for (const key of ["text", "content", "value"]) {
    if (value[key] != null) {
      const text = textFromContent(value[key]);
      if (text) return text;
    }
  }
  return "";
}

function messageRole(value) {
  const role = String(value || "").toLowerCase();
  if (role === "user") return "user";
  if (role === "assistant" || role === "model") return "agent";
  return "";
}

function normalizeMessage(value) {
  const item = value?.message && typeof value.message === "object" ? value.message : value;
  const role = messageRole(item?.author?.role || item?.role);
  const content = textFromContent(item?.content ?? value?.content).trim();
  if (!role || !content) return null;
  return { role, content };
}

function messagesFromMapping(mapping, currentNode) {
  if (!mapping || typeof mapping !== "object") return [];
  const nodes = Object.values(mapping).filter((node) => node && typeof node === "object");
  let ordered = nodes;
  if (currentNode && mapping[currentNode]) {
    const chain = [];
    const seen = new Set();
    let node = mapping[currentNode];
    while (node && !seen.has(node.id)) {
      seen.add(node.id);
      chain.push(node);
      node = node.parent ? mapping[node.parent] : null;
    }
    ordered = chain.reverse();
  } else {
    ordered = [...nodes].sort((a, b) => {
      const left = Number(a.message?.create_time ?? a.create_time ?? Number.MAX_SAFE_INTEGER);
      const right = Number(b.message?.create_time ?? b.create_time ?? Number.MAX_SAFE_INTEGER);
      return left - right;
    });
  }
  return ordered.map(normalizeMessage).filter(Boolean);
}

function locateConversation(value, depth = 0) {
  if (!value || depth > 8 || typeof value !== "object") return null;
  if (value.mapping && typeof value.mapping === "object") return value;
  if (Array.isArray(value.messages)) return value;
  for (const child of Array.isArray(value) ? value : Object.values(value)) {
    const found = locateConversation(child, depth + 1);
    if (found) return found;
  }
  return null;
}

export function normalizeChatGptConversation(payload) {
  const candidate = locateConversation(payload);
  if (!candidate) throw new Error("未识别到 ChatGPT 对话数据");
  const messages = candidate.mapping
    ? messagesFromMapping(candidate.mapping, candidate.current_node || candidate.currentNode)
    : candidate.messages.map(normalizeMessage).filter(Boolean);
  if (!messages.length) throw new Error("该分享链接没有可导入的文本对话");
  return {
    title: String(candidate.title || payload?.title || "").trim(),
    messages
  };
}

function decodeHtml(text) {
  return String(text || "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;/gi, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([\da-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)));
}

function htmlText(fragment) {
  return decodeHtml(String(fragment || "")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim());
}

function scriptsFromHtml(html) {
  const scripts = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = re.exec(html))) {
    const attrs = match[1] || "";
    const body = match[2] || "";
    if (/__NEXT_DATA__/i.test(attrs) || /application\/json/i.test(attrs)) scripts.push(body.trim());
  }
  return scripts;
}

export function parseChatGptShareHtml(html) {
  const text = String(html || "");
  for (const script of scriptsFromHtml(text)) {
    try {
      const parsed = normalizeChatGptConversation(JSON.parse(script));
      if (parsed.messages.length) return parsed;
    } catch {
      // Try the next embedded payload or the server-rendered message markers.
    }
  }

  const markers = [];
  const markerRe = /data-message-author-role\s*=\s*["'](user|assistant)["']/gi;
  let match;
  while ((match = markerRe.exec(text))) {
    const start = text.lastIndexOf("<", match.index);
    const end = text.indexOf(">", markerRe.lastIndex) + 1;
    markers.push({ role: messageRole(match[1]), start, end });
  }
  const messages = markers.map((marker, index) => {
    const end = markers[index + 1]?.start || text.length;
    return { role: marker.role, content: htmlText(text.slice(marker.end, end)) };
  }).filter((message) => message.content);
  if (!messages.length) throw new Error("未识别到 ChatGPT 对话数据");
  const titleMatch = text.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return { title: htmlText(titleMatch?.[1] || ""), messages };
}

async function fetchDocument(url) {
  let current = url;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      const response = await fetchWithFallback(current, {
        headers: {
          "User-Agent": USER_AGENT,
          Accept: "text/html,application/json;q=0.9,*/*;q=0.8"
        },
        redirect: "manual",
        signal: controller.signal
      }, getProxyUrl());
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location) throw new Error("ChatGPT 分享链接重定向目标缺失");
        const next = new URL(location, current);
        if (next.protocol !== "https:" || !allowedHost(next)) throw new Error("ChatGPT 分享链接重定向到非法地址");
        current = next.toString();
        continue;
      }
      if (!response.ok) throw new Error(`ChatGPT 返回 ${response.status}`);
      const length = Number(response.headers.get("content-length") || 0);
      if (length > MAX_RESPONSE_BYTES) throw new Error("ChatGPT 分享页面过大，无法导入");
      const buffer = await response.arrayBuffer();
      if (buffer.byteLength > MAX_RESPONSE_BYTES) throw new Error("ChatGPT 分享页面过大，无法导入");
      return { text: new TextDecoder().decode(buffer), url: current };
    }
  } finally {
    clearTimeout(timer);
  }
  throw new Error("ChatGPT 分享链接重定向次数过多");
}

export async function importChatGptShare(value) {
  const parsedUrl = parseChatGptShareUrl(value);
  const page = await fetchDocument(parsedUrl.url);
  try {
    const conversation = parseChatGptShareHtml(page.text);
    return { ...parsedUrl, title: conversation.title, messages: conversation.messages };
  } catch {
    const apiUrl = new URL(`/backend-api/shared_conversations/${parsedUrl.shareId}`, page.url).toString();
    const apiPage = await fetchDocument(apiUrl);
    let payload;
    try {
      payload = JSON.parse(apiPage.text);
    } catch {
      throw new Error("ChatGPT 分享数据不是有效的 JSON");
    }
    const conversation = normalizeChatGptConversation(payload);
    return { ...parsedUrl, title: conversation.title, messages: conversation.messages };
  }
}

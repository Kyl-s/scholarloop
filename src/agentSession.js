import { useSyncExternalStore } from "react";
import { api } from "./api.js";
import { clearJournalLink } from "./agentJournal.js";

const CHAT_KEY = "scholarloop.agent.chat";

export function asText(text) {
  if (typeof text === "string") return text;
  if (Array.isArray(text)) return text.map((part) => {
    if (typeof part === "string") return part;
    if (part && typeof part === "object") return part.text || part.content || JSON.stringify(part);
    return String(part || "");
  }).join("\n");
  return text ? String(text) : "";
}

export function compactToolCalls(toolCalls) {
  return (Array.isArray(toolCalls) ? toolCalls : []).slice(0, 6).map((call) => ({
    name: String(call?.name || ""),
    args: call?.args && typeof call.args === "object" ? call.args : {},
    result: call?.result
  })).filter((call) => call.name);
}

export function sanitizeMessage(message) {
  if (!message || typeof message !== "object") return message;
  const content = asText(message.content);
  return content === message.content ? message : { ...message, content };
}

// Request ownership belongs to the session, not either mounted chat surface.
export function createAgentSession({ storage, chat, onClear = () => {} }) {
  let messages = [];
  try {
    const saved = JSON.parse(storage?.getItem(CHAT_KEY) || "[]");
    if (Array.isArray(saved)) messages = saved.filter((m) => m && typeof m === "object").map(sanitizeMessage);
  } catch { /* Start empty if saved history is unreadable. */ }
  let state = { messages, busy: false, input: "" };
  const listeners = new Set();
  const update = (patch) => {
    state = { ...state, ...patch };
    if (Object.hasOwn(patch, "messages")) {
      try { storage?.setItem(CHAT_KEY, JSON.stringify(state.messages)); }
      catch { /* Storage failure must not interrupt an active conversation. */ }
    }
    listeners.forEach((listener) => listener());
  };
  return {
    getSnapshot: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setInput: (input) => update({ input }),
    clear() {
      if (state.busy) return false;
      update({ messages: [], input: "" });
      onClear();
      return true;
    },
    async send(text, config, refresh) {
      const content = (text ?? state.input).trim();
      if (!content || state.busy || !config) return false;
      const history = [...state.messages.map(sanitizeMessage), { role: "user", content }];
      update({ messages: history, busy: true, input: "" });
      try {
        const result = await chat({ messages: history, config });
        update({ messages: [...history, {
          role: "agent",
          content: asText(result.content) || "Agent 没有返回内容。",
          toolCalls: compactToolCalls(result.toolCalls)
        }] });
        if (result.toolCalls?.some((tool) => tool.name === "complete_task")) {
          // Data refresh failure should not overwrite a successful model reply.
          try { await refresh?.(); } catch { /* Refresh can be retried by the data layer. */ }
        }
      } catch (error) {
        update({ messages: [...history, { role: "agent", content: "出错了：" + error.message, toolCalls: [] }] });
      } finally {
        update({ busy: false });
      }
      return true;
    }
  };
}

let session;
export function useAgentSession() {
  if (!session) {
    let storage;
    try { storage = globalThis.localStorage; } catch { /* Storage may be unavailable. */ }
    session = createAgentSession({ storage, chat: api.agentChat, onClear: clearJournalLink });
  }
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot);
  return { ...state, setInput: session.setInput, sendMessage: session.send, clearMessages: session.clear };
}

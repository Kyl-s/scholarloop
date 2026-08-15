const JOURNAL_LINK_KEY = "scholarloop.agent.journalLink";

export function journalFingerprint(messages) {
  return (messages || [])
    .map((m) => `${m.role}:${String(m?.content || "").trim()}`)
    .join("\n---\n");
}

export function loadJournalLink() {
  try {
    const raw = localStorage.getItem(JOURNAL_LINK_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function rememberJournalLink(id, fingerprint) {
  if (!id) return;
  localStorage.setItem(JOURNAL_LINK_KEY, JSON.stringify({ id, fingerprint }));
}

export function clearJournalLink() {
  localStorage.removeItem(JOURNAL_LINK_KEY);
}

/** 同一段 Agent 对话只对应一份思考记录：内容没变则跳过，有新对话则覆盖原记录。 */
export async function persistAgentJournal({ messages, config, saveJournal }) {
  const fingerprint = journalFingerprint(messages);
  const link = loadJournalLink();
  if (link?.id && link.fingerprint === fingerprint) {
    return { reused: true, saved: null };
  }
  const saved = await saveJournal({
    id: link?.id || undefined,
    messages,
    config
  });
  rememberJournalLink(saved.id, fingerprint);
  return { reused: false, saved };
}

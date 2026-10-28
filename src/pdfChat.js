export function createPendingFollowup(id, question) {
  return {
    id,
    q: String(question || "").trim(),
    a: "",
    evidence: [],
    status: "thinking"
  };
}

export function settleFollowup(followups, id, answer, status = "done", evidence = [], extra = {}) {
  const list = Array.isArray(followups) ? followups : [];
  const settled = {
    id,
    q: String(extra.q || extra.question || "").trim(),
    a: String(answer || ""),
    evidence: Array.isArray(evidence) ? evidence : [],
    status
  };
  let found = false;
  const next = list.map((item) => {
    if (item.id !== id) return item;
    found = true;
    return { ...item, a: settled.a, evidence: settled.evidence, status: settled.status };
  });
  if (found) return next;
  return [...next, { ...settled, q: settled.q || "（追问）" }];
}

/**
 * 引导步骤内的持续对话：在某个回答记录上追加一条消息（用户或导师）
 */
export function appendDialogMessage(record, { role, text, evidence = [], error = false, at = "" } = {}) {
  const isAssistant = role === "assistant";
  const message = {
    role: isAssistant ? "assistant" : "user",
    text: String(text || ""),
    evidence: isAssistant && Array.isArray(evidence) ? evidence : [],
    error: isAssistant ? Boolean(error) : false,
    at: String(at || new Date().toISOString())
  };
  const dialog = Array.isArray(record?.dialog) ? record.dialog : [];
  return [...dialog, message];
}

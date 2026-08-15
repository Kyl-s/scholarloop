export function createPendingFollowup(id, question) {
  return {
    id,
    q: String(question || "").trim(),
    a: "",
    evidence: [],
    status: "thinking"
  };
}

export function settleFollowup(followups, id, answer, status = "done", evidence = []) {
  return followups.map((item) =>
    item.id === id ? { ...item, a: String(answer || ""), evidence: Array.isArray(evidence) ? evidence : [], status } : item
  );
}

import test from "node:test";
import assert from "node:assert/strict";
import { journalFingerprint } from "./agentJournal.js";

test("同一段对话指纹稳定，改一句就变", () => {
  const a = [
    { role: "user", content: "什么是注意力" },
    { role: "agent", content: "注意力是加权求和。" }
  ];
  const b = [
    { role: "user", content: "什么是注意力" },
    { role: "agent", content: "注意力是加权求和。" }
  ];
  const c = [
    { role: "user", content: "什么是注意力" },
    { role: "agent", content: "注意力是加权求和。" },
    { role: "user", content: "再举个例子" }
  ];
  assert.equal(journalFingerprint(a), journalFingerprint(b));
  assert.notEqual(journalFingerprint(a), journalFingerprint(c));
});

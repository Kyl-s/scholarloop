import test from "node:test";
import assert from "node:assert/strict";
import { sourceStatusView, classifySourceError } from "./sourceStatus.js";

test("source badges distinguish partial, successful empty and skipped execution", () => {
  assert.deepEqual(sourceStatusView({ state: "partial", ok: true }), { state: "partial", label: "部分成功", tone: "partial" });
  assert.equal(sourceStatusView({ state: "empty" }).label, "成功 · 无展示结果");
  assert.equal(sourceStatusView({ state: "unconfigured" }).tone, "muted");
  assert.equal(sourceStatusView({ ok: false }).state, "failed");
});

test("aborted proxy fallback and upstream HTTP failures retain useful categories", () => {
  assert.equal(classifySourceError(new Error("proxy error; direct operation aborted")).type, "timeout");
  assert.equal(classifySourceError({ status: 403 }).retryable, false);
  assert.equal(classifySourceError({ status: 429 }).type, "rate_limit");
});

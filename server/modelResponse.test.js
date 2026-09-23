import assert from "node:assert/strict";
import test from "node:test";
import {
  extractModelFinishReason,
  extractModelReasoning,
  extractModelText,
  modelResponseError
} from "./modelResponse.js";

test("extracts final text next to reasoning content from compatible responses", () => {
  const data = {
    choices: [{
      finish_reason: "stop",
      message: {
        reasoning_content: "先分析页面",
        output_text: "{\"version\":\"page-context-v1\"}"
      }
    }]
  };

  assert.equal(extractModelText(data), '{"version":"page-context-v1"}');
  assert.equal(extractModelReasoning(data), "先分析页面");
  assert.equal(extractModelFinishReason(data), "stop");
});

test("extracts Responses-style output text without treating reasoning as output", () => {
  const data = {
    output: [
      { type: "reasoning", content: [{ type: "reasoning_text", text: "内部推理" }] },
      { type: "message", content: [{ type: "output_text", text: "最终 JSON" }] }
    ]
  };

  assert.equal(extractModelText(data), "最终 JSON");
  assert.equal(extractModelReasoning(data), "");
});

test("does not mistake reasoning-only JSON for a final response", () => {
  const data = {
    choices: [{
      message: {
        reasoning_content: '{"version":"page-context-v1"}',
        content: ""
      }
    }]
  };

  assert.equal(extractModelText(data), "");
  assert.match(modelResponseError(data), /只返回了思考过程/);
});

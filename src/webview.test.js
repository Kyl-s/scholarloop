import test from "node:test";
import assert from "node:assert/strict";
import { webviewFailureMessage } from "./webview.js";

test("does not cover the whole page for a failed WebVPN subframe", () => {
  assert.equal(webviewFailureMessage({ isMainFrame: false, errorCode: -105, errorDescription: "ERR_NAME_NOT_RESOLVED" }), "");
});

test("ignores normal navigation aborts during authentication redirects", () => {
  assert.equal(webviewFailureMessage({ isMainFrame: true, errorCode: -3, errorDescription: "ERR_ABORTED" }), "");
});

test("keeps actionable details for a real main-frame failure", () => {
  assert.equal(webviewFailureMessage({ isMainFrame: true, errorCode: -105, errorDescription: "ERR_NAME_NOT_RESOLVED" }), "ERR_NAME_NOT_RESOLVED (-105)");
});

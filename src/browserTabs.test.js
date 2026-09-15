import test from "node:test";
import assert from "node:assert/strict";
import {
  closeBrowserTab,
  createBlankBrowserTab,
  createBrowserTab,
  createBrowserTabState,
  focusBrowserTab,
  getBrowserTabLabel,
  isSafeBrowserUrl,
  normalizeBrowserUrl,
  updateBrowserTab,
  upsertBrowserTab
} from "./browserTabs.js";

const first = createBrowserTab({ id: "first", url: "https://library.example.edu/", title: "图书馆" });
const second = createBrowserTab({ id: "second", url: "https://ieeexplore.ieee.org/", title: "IEEE" });

test("accepts only http and https URLs", () => {
  assert.equal(isSafeBrowserUrl("https://library.example.edu/login"), true);
  assert.equal(isSafeBrowserUrl("http://localhost:3000/"), true);
  assert.equal(isSafeBrowserUrl("javascript:window.open('https://evil.example')"), false);
  assert.equal(isSafeBrowserUrl("file:///C:/secret.pdf"), false);
  assert.equal(isSafeBrowserUrl("mailto:research@example.edu"), false);
  assert.equal(isSafeBrowserUrl(""), false);
  assert.equal(normalizeBrowserUrl("  https://library.example.edu/a  "), "https://library.example.edu/a");
});

test("creates normalized tabs and deduplicates initial state", () => {
  const duplicate = createBrowserTab({ id: "other", url: "https://library.example.edu/" });
  const state = createBrowserTabState([first, duplicate, second], "second");
  assert.deepEqual(state.tabs.map((tab) => tab.id), ["first", "second"]);
  assert.equal(state.activeId, "second");
  assert.equal(createBrowserTab({ url: "javascript:alert(1)" }), null);
});

test("focuses an existing tab and upserts duplicate URLs", () => {
  const state = createBrowserTabState([first, second], "first");
  assert.equal(focusBrowserTab(state, "second").activeId, "second");

  const updated = upsertBrowserTab(state, {
    id: "popup",
    url: "https://library.example.edu/",
    title: "登录入口"
  });
  assert.equal(updated.tabs.length, 2);
  assert.equal(updated.activeId, "first");
  assert.equal(updated.tabs[0].title, "登录入口");

  const added = upsertBrowserTab(state, { id: "popup", url: "https://library.example.edu/db" });
  assert.equal(added.tabs.length, 3);
  assert.equal(added.activeId, "popup");
});

test("closes dynamic tabs and selects the adjacent tab", () => {
  const third = createBrowserTab({ id: "third", url: "https://sciencedirect.com/", closable: true });
  const state = createBrowserTabState([first, second, third], "second");
  assert.deepEqual(closeBrowserTab(state, "second"), {
    tabs: [first, third],
    activeId: "first"
  });
  assert.equal(closeBrowserTab(createBrowserTabState([first, second], "first"), "first").activeId, "second");
  const protectedState = createBrowserTabState([{ ...first, closable: false }, second], "first");
  assert.deepEqual(closeBrowserTab(protectedState, "first"), protectedState);
});

test("updates title and URL but rejects unsafe navigation", () => {
  const state = createBrowserTabState([first], "first");
  const titled = updateBrowserTab(state, "first", { title: "  新标题  " });
  assert.equal(titled.tabs[0].title, "新标题");
  const moved = updateBrowserTab(titled, "first", { url: "https://library.example.edu/paper.pdf" });
  assert.equal(moved.tabs[0].url, "https://library.example.edu/paper.pdf");
  const rejected = updateBrowserTab(moved, "first", { url: "file:///C:/secret.pdf" });
  assert.deepEqual(rejected, moved);
});

test("prefers page title and falls back to URL hostname", () => {
  assert.equal(getBrowserTabLabel({ title: " IEEE Xplore ", url: "https://ieeexplore.ieee.org/" }), "IEEE Xplore");
  assert.equal(getBrowserTabLabel({ title: "", url: "https://www.example.edu/path" }), "www.example.edu");
  assert.equal(getBrowserTabLabel({ title: "", url: "not a URL" }), "新标签");
});



test("creates a browser-like blank tab", () => {
  const blank = createBlankBrowserTab({ id: "blank-test" });
  assert.deepEqual(blank, { id: "blank-test", url: "", title: "新标签", siteId: "blank", closable: true, blank: true });
});

const test = require("node:test");
const assert = require("node:assert/strict");
const { createInstitutionPopupHandler, safeHttpUrl } = require("./institutionPopup.cjs");

test("safeHttpUrl accepts absolute HTTP(S) URLs and trims whitespace", () => {
  assert.equal(safeHttpUrl("  https://library.example.edu/login?target=1  "), "https://library.example.edu/login?target=1");
  assert.equal(safeHttpUrl("http://127.0.0.1:8080/path"), "http://127.0.0.1:8080/path");
});

test("safeHttpUrl rejects non-web, empty, and malformed targets", () => {
  for (const value of ["", "   ", "javascript:alert(1)", "file:///C:/secret.pdf", "data:text/html,hello", "about:blank", "://broken"]) {
    assert.equal(safeHttpUrl(value), null, value);
  }
  assert.equal(safeHttpUrl(null), null);
  assert.equal(safeHttpUrl({ toString: () => "https://spoof.example" }), null);
});

test("popup handler always denies native windows and routes only safe HTTP(S) URLs", () => {
  const forwarded = [];
  const rejected = [];
  const handle = createInstitutionPopupHandler({ notify: (url) => forwarded.push(url), onRejected: (url) => rejected.push(url) });
  assert.deepEqual(handle({ url: "https://library.example.edu/database" }), { action: "deny" });
  assert.deepEqual(handle({ url: "http://library.example.edu/login" }), { action: "deny" });
  assert.deepEqual(handle({ url: "file:///C:/secret.pdf" }), { action: "deny" });
  assert.deepEqual(handle({ url: "javascript:alert(1)" }), { action: "deny" });
  assert.deepEqual(forwarded, ["https://library.example.edu/database", "http://library.example.edu/login"]);
  assert.deepEqual(rejected, ["file:///C:/secret.pdf", "javascript:alert(1)"]);
});

test("popup handler remains safe with missing or malformed details", () => {
  const forwarded = [];
  const handle = createInstitutionPopupHandler({ notify: (url) => forwarded.push(url) });
  assert.deepEqual(handle(), { action: "deny" });
  assert.deepEqual(handle({ url: "javascript:alert(1)" }), { action: "deny" });
  assert.deepEqual(forwarded, []);
});

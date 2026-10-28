import assert from "node:assert/strict";
import { chromium } from "playwright";

const baseUrl = process.env.SCHOLARLOOP_URL || "http://127.0.0.1:8787";
const title = "Vision-and-Language Navigation: A Survey of Tasks, Methods, and Future Directions";
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errors = [];
let translationRequests = 0;
const restoreFingerprints = [];
page.on("request", (request) => {
  if (request.url().includes("/pdf-layout-translation?")) {
    restoreFingerprints.push(new URL(request.url()).searchParams.get("sourceSha256"));
  }
});
page.on("pageerror", (error) => errors.push(error.message));
await page.route("**/api/pdf/translate-layout", async (route) => {
  if (route.request().method() === "POST") {
    translationRequests += 1;
    return route.abort();
  }
  return route.continue();
});
// Deliberately different translator; the saved PDFs must still be readable.
await page.addInitScript(() => localStorage.setItem("scholarloop.agent.config", JSON.stringify({
  apiKey: "dummy-local-recovery-test", model: "changed-model", baseUrl: "https://example.invalid/v1"
})));

async function openPaper(paperTitle) {
  await page.goto(baseUrl);
  await page.locator(".nav-list .nav-item").filter({ hasText: "文献库" }).click();
  await page.getByText(paperTitle, { exact: true }).click();
  await page.getByRole("button", { name: "内置阅读器", exact: true }).last().click();
  await page.locator(".pdf-layout-status-count").waitFor();
}

try {
  await openPaper(title);
  if (process.env.EXPECT_MISSING === "1") {
    await page.waitForTimeout(2500);
    assert.equal((await page.locator(".pdf-layout-status-count").innerText()).trim(), "0/18");
    console.log("Reproduced: saved 18-page translation hidden as 0/18.");
  } else {
    await page.waitForFunction(() => document.querySelector(".pdf-layout-status-count")?.textContent.trim() === "18/18");
    await page.getByRole("button", { name: "译文", exact: true }).first().click();
    await page.waitForFunction(() => document.querySelector(".pdf-reader")?.textContent.includes("摘要"));
    await page.getByRole("button", { name: "中英对照", exact: true }).first().click();
    await page.waitForTimeout(700);
    await page.getByRole("button", { name: "下一页 (→)", exact: true }).click();
    await page.waitForTimeout(700);
    await page.screenshot({ path: "tmp/translation-recovery-20260930/after.png" });
    await page.reload();
    await page.locator(".nav-list .nav-item").filter({ hasText: "文献库" }).click();
    await page.getByText(title, { exact: true }).click();
    await page.getByRole("button", { name: "内置阅读器", exact: true }).last().click();
    await page.waitForFunction(() => document.querySelector(".pdf-layout-status-count")?.textContent.trim() === "18/18");
    await openPaper("Vision-and-Language Navigation Today and Tomorrow: A Survey in the Era of Foundation Models");
    await page.waitForFunction(() => document.querySelector(".pdf-layout-status-count")?.textContent.trim().startsWith("6/"));
    await page.getByRole("button", { name: "译文", exact: true }).first().click();
    await page.waitForFunction(() => document.querySelector(".pdf-layout-view-status")?.textContent.includes("译文已就绪"));
    assert.ok(restoreFingerprints.length >= 3);
    assert.ok(restoreFingerprints.every((value) => /^[a-f0-9]{64}$/.test(value)), "Hash the PDF before the worker detaches its buffer");
    console.log("Restored complete 18-page and legacy partial 6-page translations; reopening preserves progress.");
  }
  assert.equal(translationRequests, 0, "Restoring must not submit new translation requests");
  assert.deepEqual(errors, []);
} finally {
  await browser.close();
}




import assert from "node:assert/strict";
import { chromium } from "playwright";

const baseUrl = process.env.SCHOLARLOOP_URL || "http://127.0.0.1:8787";
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
const pageErrors = [];
page.on("pageerror", (error) => pageErrors.push(error));

async function openSettings() {
  await page.locator(".nav-list .nav-item").filter({ hasText: "设置" }).click();
  await page.locator(".settings-page").waitFor({ state: "visible" });
}

function learningPathCheckbox() {
  return page.locator(".settings-toggle-row").filter({ hasText: "启用学习路径" }).locator("input");
}

async function setLearningPath(enabled) {
  const row = page.locator(".settings-toggle-row").filter({ hasText: "启用学习路径" });
  const checkbox = learningPathCheckbox();
  if ((await checkbox.isChecked()) !== enabled) await row.click();
  await page.waitForFunction((expected) => {
    const toggle = [...document.querySelectorAll(".settings-toggle-row")]
      .find((element) => element.textContent.includes("启用学习路径"));
    const input = toggle?.querySelector("input");
    return input && input.checked === expected;
  }, enabled);
}

async function assertRendered(selector) {
  await page.locator(selector).waitFor({ state: "visible" });
  assert.equal(pageErrors.length, 0, `renderer errors: ${pageErrors.map((error) => error.message).join(" | ")}`);
}

try {
  const initialSettings = await page.request.get(`${baseUrl}/api/settings`).then((response) => response.json());
  const initialEnabled = initialSettings.learningPathEnabled !== false;

  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await assertRendered(".app-shell");
  await openSettings();

  await setLearningPath(!initialEnabled);
  await assertRendered(".settings-page");

  await setLearningPath(initialEnabled);
  await assertRendered(".settings-page");

  await setLearningPath(true);
  await page.locator(".nav-list .nav-item").filter({ hasText: "学习路径" }).click();
  await assertRendered(".path-page");
  await openSettings();
  await setLearningPath(false);
  assert.equal(await page.locator(".nav-list .nav-item").filter({ hasText: "学习路径" }).count(), 0);
  await assertRendered(".settings-page");
  await setLearningPath(initialEnabled);
  await page.waitForSelector(".settings-page", { state: "visible" });
} finally {
  await browser.close();
}

console.log("learning path toggle smoke test passed");

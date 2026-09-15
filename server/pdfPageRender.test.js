import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { buildPdfPageRendererEnv, resolvePdfPagePython } from "./pdfPageRender.js";

test("页面渲染 Python 子进程强制使用 UTF-8", () => {
  const env = buildPdfPageRendererEnv({ PYTHONIOENCODING: "gbk", PYTHONUTF8: "0", KEEP_ME: "yes" }, { PYTHONPATH: "fixture-site" });
  assert.equal(env.PYTHONIOENCODING, "utf-8");
  assert.equal(env.PYTHONUTF8, "1");
  assert.equal(env.PYTHONPATH, "fixture-site");
  assert.equal(env.KEEP_ME, "yes");
});

test("页面渲染 JSON 可处理含 Unicode 连字的文本", () => {
  const python = resolvePdfPagePython();
  if (!python) return;
  const script = path.resolve("server", "pdfPageRender.py");
  const probe = "import importlib.util, json, sys; spec=importlib.util.spec_from_file_location('renderer', sys.argv[1]); module=importlib.util.module_from_spec(spec); spec.loader.exec_module(module); sys.stdout.write(module.encode_payload({'text': 'Ligature ' + chr(0xfb01)}))";
  const result = spawnSync(python.cmd, [...python.extra, "-c", probe, script], {
    encoding: "utf8",
    env: { ...process.env, ...python.env, PYTHONIOENCODING: "gbk", PYTHONUTF8: "0" },
    windowsHide: true
  });
  assert.equal(result.status, 0, String(result.stderr || result.stdout));
  assert.equal(JSON.parse(result.stdout).text, "Ligature ﬁ");
});

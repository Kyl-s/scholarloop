import fs from "node:fs";
import path from "node:path";

function escapePdfText(value) {
  return String(value || "").replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

/**
 * 生成一个最小但完全合法的 PDF（带 xref），供测试夹具使用。
 * 生成的页面有真实文本层，PyMuPDF 可以正常抽取（避免假 %PDF-1.4 被严格回贴校验判失败）。
 */
export function buildMinimalPdf({ pages = 1, text = "Sample page text" } = {}) {
  const pageCount = Math.max(1, Math.floor(Number(pages) || 1));
  const fontObject = 3 + pageCount * 2;
  const objects = [];
  objects.push("<< /Type /Catalog /Pages 2 0 R >>");
  const kids = Array.from({ length: pageCount }, (_, index) => `${3 + index * 2} 0 R`).join(" ");
  objects.push(`<< /Type /Pages /Kids [${kids}] /Count ${pageCount} >>`);
  for (let index = 0; index < pageCount; index += 1) {
    const pageObject = 3 + index * 2;
    const contentObject = pageObject + 1;
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontObject} 0 R >> >> /Contents ${contentObject} 0 R >>`
    );
    const content = `BT /F1 12 Tf 72 720 Td (${escapePdfText(text)}) Tj ET`;
    objects.push(`<< /Length ${Buffer.byteLength(content, "latin1")} >>\nstream\n${content}\nendstream`);
  }
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");

  let pdf = "%PDF-1.4\n";
  const offsets = [];
  for (let index = 0; index < objects.length; index += 1) {
    offsets.push(Buffer.byteLength(pdf, "latin1"));
    pdf += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(pdf, "latin1");
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(pdf, "latin1");
}

/** 把一个合法 PDF 写到指定文件，返回路径 */
export function writeMinimalPdf(file, options = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, buildMinimalPdf(options));
  return file;
}

/**
 * 生成“假 pdf2zh 命令”把真实 PDF 复制为 source.zh.mono.pdf 的批处理/脚本行。
 * 用于让译文产物能被 PyMuPDF 抽取，同时保持测试不依赖真实翻译引擎。
 */
export function pdfOutputCopyLines(outputPdf, { platform = process.platform } = {}) {
  const quoted = String(outputPdf).replace(/"/g, '""');
  if (platform === "win32") {
    return [
      "if not exist \"%OUT%\" mkdir \"%OUT%\"",
      `copy /y "${quoted}" "%OUT%\\source.zh.mono.pdf" >nul`
    ];
  }
  return [
    "mkdir -p \"$3\"",
    `cp '${String(outputPdf).replace(/'/g, "'\\''")}' "$3/source.zh.mono.pdf"`
  ];
}

/** 测试用真实输入 PDF：包含足够页数，保证第 N 页可被抽取 */
export function testSourcePdf(pageCount = 4) {
  return buildMinimalPdf({ pages: pageCount, text: "Original page text" });
}

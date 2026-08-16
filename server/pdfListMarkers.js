import fs from "node:fs";

const UNICODE_BULLET_RE = /[■•⚫⬤◆◇○●◦‣⁃▪▫∗†‡¶※·]/;

/** 期刊常用「假子弹」：Pi/Ding/Symbol 字体里的单字符方块 */
export function isDingbatFontName(name) {
  return /(pi|ding|symbol|wingding|zapf|ornament)/i.test(String(name || ""));
}

/**
 * 行首是否为列表标记。
 * Cell 亮点：AdvPSMPi6 的 'd'（6.5pt 青块）+ 后接 10pt 正文，不是 Unicode 圆点。
 */
export function isListMarkerSpan(first, next) {
  const text = String(first?.text ?? "").replace(/\s+/g, "");
  if (!text) return false;
  if (UNICODE_BULLET_RE.test(text)) return true;
  if (text.length !== 1) return false;
  if (isDingbatFontName(first?.fontName) && !isDingbatFontName(next?.fontName)) return true;
  const firstSize = Number(first?.fontSize) || 0;
  const nextSize = Number(next?.fontSize) || 0;
  const firstFont = String(first?.fontName || first?.fontId || "");
  const nextFont = String(next?.fontName || next?.fontId || "");
  return Boolean(
    firstFont
    && nextFont
    && firstFont !== nextFont
    && firstSize > 0
    && nextSize > 0
    && firstSize < nextSize * 0.85
  );
}

export const PDF2ZH_LIST_MARKER_SENTINEL = "SCHOLARLOOP_LIST_MARKER";

export const PDF2ZH_LIST_MARKER_PY = `
def scholarloop_is_list_marker_line(line) -> bool:
    """${PDF2ZH_LIST_MARKER_SENTINEL}: 行首 Unicode 项目符号，或期刊 Pi 字体小符号。"""
    chars = getattr(line, "pdf_character", None) or []
    if not chars:
        return False
    first = chars[0]
    if is_bullet_point(first):
        return True
    text = first.char_unicode or ""
    if len(text) != 1 or text.isspace():
        return False
    style = first.pdf_style
    first_size = (style.font_size if style else 0) or 0
    first_font = (style.font_id if style else "") or ""
    body = [c for c in chars[1:] if (c.char_unicode or "").strip()]
    if not body or not body[0].pdf_style:
        return False
    body_size = body[0].pdf_style.font_size or 0
    body_font = body[0].pdf_style.font_id or ""
    if first_font and body_font and first_font != body_font and first_size and body_size and first_size < body_size * 0.85:
        return True
    return False
`.trim();

export function applyPdf2zhListMarkerPatch(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return { ok: false, reason: "missing" };
  const original = fs.readFileSync(filePath, "utf8");
  if (original.includes(PDF2ZH_LIST_MARKER_SENTINEL)) return { ok: true, reason: "already" };
  if (!original.includes("and is_bullet_point(char)")) {
    return { ok: false, reason: "pattern-miss" };
  }
  const next = original.replace(
    "and is_bullet_point(char)",
    "and scholarloop_is_list_marker_line(line)"
  );
  fs.writeFileSync(filePath, `${next}\n\n${PDF2ZH_LIST_MARKER_PY}\n`, "utf8");
  return { ok: true, reason: "patched" };
}

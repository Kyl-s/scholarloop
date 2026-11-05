"""从原文 PDF 抽出文本行/span，或把指定矩形（含 formula-span）盖回译文页。"""
from __future__ import annotations

import collections
import json
import os
import re
import sys


def _span_text(span: dict, include_chars: bool) -> str:
    """rawdict 的 span 没有 text 字段，需要由 chars 拼回；dict 直接有 text。"""
    if include_chars:
        return "".join(ch.get("c", "") for ch in span.get("chars") or [])
    return span.get("text", "")


def _span_payload(span: dict, include_chars: bool) -> dict:
    sx0, sy0, sx1, sy1 = span.get("bbox") or (0, 0, 0, 0)
    origin = span.get("origin") or (sx0, sy1)
    payload = {
        "text": _span_text(span, include_chars),
        "x0": round(float(sx0), 2),
        "y0": round(float(sy0), 2),
        "x1": round(float(sx1), 2),
        "y1": round(float(sy1), 2),
        "originX": round(float(origin[0]), 2),
        "originY": round(float(origin[1]), 2),
        "font": span.get("font") or "",
        "size": round(float(span.get("size") or 0), 2),
        "flags": int(span.get("flags") or 0),
    }
    if include_chars:
        chars = []
        for ch in span.get("chars") or []:
            cx0, cy0, cx1, cy1 = ch.get("bbox") or (0, 0, 0, 0)
            chars.append({
                "c": ch.get("c", ""),
                "x0": round(float(cx0), 2),
                "y0": round(float(cy0), 2),
                "x1": round(float(cx1), 2),
                "y1": round(float(cy1), 2),
            })
        payload["chars"] = chars
    return payload


def extract_lines(pdf_path: str, page_no: int, include_chars: bool = False) -> dict:
    import fitz

    doc = fitz.open(pdf_path)
    index = max(0, int(page_no) - 1)
    if index >= doc.page_count:
        doc.close()
        raise ValueError("extract-page-missing")
    page = doc[index]
    # rawdict 才带逐字符 bbox；不需要 chars 时仍用 dict，输出更小。
    raw = page.get_text("rawdict" if include_chars else "dict")
    lines = []
    for block in raw.get("blocks", []):
        if block.get("type") != 0:
            continue
        for line in block.get("lines", []):
            spans = line.get("spans") or []
            text = "".join(_span_text(span, include_chars) for span in spans)
            if not text.strip():
                continue
            x0, y0, x1, y1 = line["bbox"]
            size = 0.0
            if spans:
                size = float(spans[0].get("size") or 0)
            lines.append({
                "text": text,
                "x0": round(x0, 2),
                "y0": round(y0, 2),
                "x1": round(x1, 2),
                "y1": round(y1, 2),
                "size": round(size, 1),
                # 向后兼容：原有行字段保持不变，只新增 span 明细。
                "spans": [_span_payload(span, include_chars) for span in spans],
            })
    result = {
        "width": round(page.rect.width, 2),
        "height": round(page.rect.height, 2),
        "lines": lines,
    }
    doc.close()
    return result


_CJK_RE = re.compile(r"[\u3400-\u9fff]")
_LETTER_TOKEN_RE = re.compile(r"[A-Za-z]+")
# 与 JS 的 PROSE_WORD_RUN_RE / MATH_FUNC_WORD_RE 同阈值：连续 ≥3 个 ≥2 字母英文词 = 散文。
_PROSE_WORD_RUN_RE = re.compile(r"[A-Za-z]{2,}(?:\s*[,;:.)\]]?\s+[A-Za-z]{2,}){2,}")
_MATH_FUNC_WORD_RE = re.compile(r"^(?:sin|cos|tan|log|exp|lim|min|max|arg|det|inf|sup)$", re.I)


def _is_pure_formula_source(text) -> bool:
    """源行是否「纯公式行」（JS isPureFormulaSourceLine 的同阈值实现）。"""
    t = re.sub(r"\s+", " ", str(text or "")).strip()
    if not t or _CJK_RE.search(t):
        return False
    if _PROSE_WORD_RUN_RE.search(t):
        return False
    tokens = _LETTER_TOKEN_RE.findall(t)
    if not tokens:
        return True
    total_letters = sum(len(word) for word in tokens)
    word_letters = sum(
        len(word) for word in tokens
        if len(word) >= 3 and not _MATH_FUNC_WORD_RE.match(word)
    )
    return word_letters <= total_letters * 0.2


def _allows_chinese_overlap(box) -> bool:
    """只有视觉 equation 区域、纯公式源行、span 级公式框和首页 front-matter 允许覆盖自己的中文译文。"""
    reason = str(box.get("reason") or "")
    if reason in ("vision-equation", "formula-span", "front-matter"):
        return True
    return reason == "formula" and _is_pure_formula_source(box.get("sourceText"))


def _line_belongs_to_box(box, line_rect) -> bool:
    """与 pdfPreserveRegions.js 的 chineseLineBelongsToBox 使用同一规则/阈值。

    - 中文行 ≥60% 面积落在框内；
    - 中文行宽度不超过框宽 1.2 倍、水平中心在框内（允许 2pt 抽取误差），
      且垂直方向确实落在公式行带内（防止只擦到下一行中文的边）。
    满足任一即视为「框内内容本来就被译成了这行中文」，允许回贴覆盖。
    """
    overlap = box & line_rect
    if overlap.is_empty or overlap.width <= 0 or overlap.height <= 0:
        return False
    line_area = line_rect.width * line_rect.height
    if line_area > 0 and (overlap.width * overlap.height) / line_area >= 0.6:
        return True
    center_x = (line_rect.x0 + line_rect.x1) / 2
    vertical_ratio = overlap.height / min(box.height, line_rect.height)
    return (line_rect.width <= box.width * 1.2
            and box.x0 - 2 <= center_x <= box.x1 + 2
            and vertical_ratio >= 0.6)


_MATH_FONT_RE = re.compile(r"^(?:(?!CMTT)CM[A-Z]{1,4}|MS[AB]M|MSAM|EUSM|EURM|EUFM|RSFS)\d*$")
_FORMULA_NORMALIZE = str.maketrans({
    "−": "-",
    "∼": "~",
    "∗": "*",
    "′": "'",
    "″": '"',
    "–": "-",
    "—": "-",
})


def _normalize_formula(text) -> str:
    return re.sub(r"\s+", "", str(text or "").translate(_FORMULA_NORMALIZE))


def _page_chars(page) -> list[dict]:
    """一次 rawdict 抽取，缓存整页逐字符 bbox（CJK 守卫 / mask / 校验共用）。"""
    out = []
    for block in page.get_text("rawdict").get("blocks", []):
        if block.get("type") != 0:
            continue
        for line in block.get("lines", []):
            for span in line.get("spans", []):
                font = span.get("font") or ""
                for ch in span.get("chars", []):
                    text = ch.get("c") or ""
                    bbox = ch.get("bbox") or (0, 0, 0, 0)
                    rect = _rect(bbox[0], bbox[1], bbox[2], bbox[3])
                    if rect.is_empty:
                        continue
                    out.append({
                        "c": text,
                        "rect": rect,
                        "font": font,
                        "is_math": bool(_MATH_FONT_RE.match(font)),
                        "is_cjk": bool(_CJK_RE.match(text)) if text else False,
                    })
    return out


def _rect(x0, y0, x1, y1):
    import fitz

    return fitz.Rect(float(x0), float(y0), float(x1), float(y1))


def _rect_area(rect) -> float:
    return max(0.0, rect.width) * max(0.0, rect.height)


def _intersection_area(a, b) -> float:
    inter = a & b
    if inter.is_empty:
        return 0.0
    return _rect_area(inter)


def _cjk_signature(chars) -> collections.Counter:
    """CJK 字符多重集：字符 + 取整后的左上角坐标，用于回贴前后逐字校验。"""
    counter = collections.Counter()
    for ch in chars:
        if not ch["is_cjk"]:
            continue
        rect = ch["rect"]
        counter[(ch["c"], round(rect.x0), round(rect.y0))] += 1
    return counter


def _count_key(text: str, key: str) -> int:
    if not key or len(key) < 2:
        return 0
    return str(text or "").count(key)


def _shrink_for_cjk(dest_rect, src_rect, cjk_chars):
    """逐字符 CJK 守卫：与 redaction 交叠 >20% 的汉字 → 收缩矩形或跳过。

    只在汉字聚集在一侧时单侧收缩；汉字横跨整个公式区域时返回 None（跳过该框），
    宁可不回贴也不擦掉中文。收缩时同步裁剪 srcClip，避免把公式横向压扁。
    """
    # redaction 实际是 destRect ±0.15pt，守卫按这个矩形计算交叠。
    probe_rect = _rect(dest_rect.x0 - 0.15, dest_rect.y0 - 0.15, dest_rect.x1 + 0.15, dest_rect.y1 + 0.15)
    bad = []
    for ch in cjk_chars:
        if not ch.get("is_cjk"):
            continue
        inter = _intersection_area(ch["rect"], probe_rect)
        if inter <= 0:
            continue
        if inter / max(0.01, _rect_area(ch["rect"])) > 0.20:
            bad.append(ch)
    if not bad:
        return dest_rect, src_rect, None
    left = min(ch["rect"].x0 for ch in bad)
    right = max(ch["rect"].x1 for ch in bad)
    left_space = left - dest_rect.x0
    right_space = dest_rect.x1 - right
    if max(left_space, right_space) < 2.0:
        return None, None, "cjk-guard-skip"
    if left_space >= right_space:
        new_x1 = left - 0.35
        if new_x1 - dest_rect.x0 < 2.0 or dest_rect.width <= 0:
            return None, None, "cjk-guard-skip"
        ratio = (new_x1 - dest_rect.x0) / dest_rect.width
        return (
            _rect(dest_rect.x0, dest_rect.y0, new_x1, dest_rect.y1),
            _rect(src_rect.x0, src_rect.y0, src_rect.x0 + src_rect.width * ratio, src_rect.y1),
            "cjk-guard-shrink",
        )
    new_x0 = right + 0.35
    if dest_rect.x1 - new_x0 < 2.0 or dest_rect.width <= 0:
        return None, None, "cjk-guard-skip"
    ratio = (dest_rect.x1 - new_x0) / dest_rect.width
    return (
        _rect(new_x0, dest_rect.y0, dest_rect.x1, dest_rect.y1),
        _rect(src_rect.x1 - src_rect.width * ratio, src_rect.y0, src_rect.x1, src_rect.y1),
        "cjk-guard-shrink",
    )


def _build_mask_doc(src_doc, src_index: int, clips: list):
    """复制源页，只保留字符中心落在 clips 内的字符，其余用中心 50%×60% 小矩形删除。

    这样 show_pdf_page(clip=...) 不会把相邻行的字母降部/正文一起复制过去。
    """
    import fitz

    mask = fitz.open()
    mask.insert_pdf(src_doc, from_page=src_index, to_page=src_index)
    page = mask[0]
    removed = 0
    for block in page.get_text("rawdict").get("blocks", []):
        if block.get("type") != 0:
            continue
        for line in block.get("lines", []):
            for span in line.get("spans", []):
                for ch in span.get("chars", []):
                    bbox = ch.get("bbox") or (0, 0, 0, 0)
                    rect = _rect(bbox[0], bbox[1], bbox[2], bbox[3])
                    if rect.is_empty:
                        continue
                    if not any(rect.intersects(clip) for clip in clips):
                        continue
                    cx = (rect.x0 + rect.x1) / 2
                    cy = (rect.y0 + rect.y1) / 2
                    if any(clip.x0 <= cx <= clip.x1 and clip.y0 <= cy <= clip.y1 for clip in clips):
                        continue
                    w, h = rect.width, rect.height
                    page.add_redact_annot(
                        _rect(
                            rect.x0 + w * 0.25,
                            rect.y0 + h * 0.2,
                            rect.x1 - w * 0.25,
                            rect.y1 - h * 0.2,
                        ),
                        fill=(1, 1, 1),
                    )
                    removed += 1
    if removed:
        page.apply_redactions(images=0)
    return mask, removed


def _verify_span_stamp(dst_page, before_chars, before_text, boxes) -> dict:
    """回贴后校验：CJK 多重集不得丢失/漂移；公式 key 出现次数不得超过原有/框数。"""
    after_chars = _page_chars(dst_page)
    before = _cjk_signature(before_chars)
    after = _cjk_signature(after_chars)
    lost = before - after
    gained = after - before
    after_text = _normalize_formula(dst_page.get_text("text"))
    key_stats = []
    by_key = collections.Counter()
    for box in boxes:
        keys = box.get("keys") or [box.get("key")]
        for key in keys:
            key = _normalize_formula(key)
            if key:
                by_key[key] += 1
    for key, expected_boxes in by_key.items():
        before_count = _count_key(before_text, key)
        after_count = _count_key(after_text, key)
        allowed = max(before_count, expected_boxes)
        key_stats.append({
            "key": key,
            "before": before_count,
            "after": after_count,
            "allowed": allowed,
        })
        if after_count > allowed:
            return {
                "ok": False,
                "reason": "span-verify-failed",
                "detail": "formula-key-duplicated",
                "key": key,
                "before": before_count,
                "after": after_count,
                "allowed": allowed,
                "cjkBefore": sum(before.values()),
                "cjkAfter": sum(after.values()),
            }
    if sum(lost.values()) > 0:
        return {
            "ok": False,
            "reason": "span-verify-failed",
            "detail": "cjk-lost",
            "lost": [
                {"text": item[0], "x": item[1], "y": item[2], "count": count}
                for item, count in list(lost.items())[:20]
            ],
            "cjkBefore": sum(before.values()),
            "cjkAfter": sum(after.values()),
        }
    return {
        "ok": True,
        "cjkBefore": sum(before.values()),
        "cjkAfter": sum(after.values()),
        "cjkGained": sum(gained.values()),
        "keys": key_stats,
    }


# 公式/视觉 equation 框允许覆盖它自己的中文译文；作者块/混排行仍严格保护，避免擦掉重排后的正文。
def stamp_boxes(payload: dict) -> dict:
    import fitz

    source = payload["source"]
    dest = payload["dest"]
    page_no = int(payload["page"])
    kind = str(payload.get("kind") or "mono")
    boxes = payload.get("boxes") or []
    src_doc = fitz.open(source)
    dst_doc = fitz.open(dest)
    src_index = max(0, page_no - 1)
    if src_index >= src_doc.page_count or dst_doc.page_count < 1:
        src_doc.close()
        dst_doc.close()
        return {"ok": False, "restored": 0, "reason": "page-missing"}
    src_page = src_doc[src_index]
    dst_page = dst_doc[0]
    src_w = src_page.rect.width
    is_dual = kind == "dual" or dst_page.rect.width > src_w * 1.5
    offset_x = src_w if is_dual else 0
    prepared = []
    span_prepared = []
    skipped = []
    # CJK 守卫用回贴前的字符位置；span 校验的基线在旧框回贴之后单独抽取，
    # 避免把「旧框本来就会覆盖中文」算成 span 回贴造成的损失。
    # 只有含 formula-span 的调用才需要 rawdict 逐字符数据。
    has_span_boxes = any(str(box.get("reason") or "") == "formula-span" for box in boxes)
    dest_chars = _page_chars(dst_page) if has_span_boxes else []
    chinese_rects = []
    for block in dst_page.get_text("dict").get("blocks", []):
        for line in block.get("lines", []):
            text = "".join(span.get("text", "") for span in line.get("spans", []))
            if _CJK_RE.search(text):
                chinese_rects.append(_rect(*line["bbox"]))
    for box in boxes:
        if str(box.get("reason") or "") == "formula-span":
            try:
                src_clip = _rect(box["srcX0"], box["srcY0"], box["srcX1"], box["srcY1"]) & src_page.rect
                dest_rect = _rect(
                    float(box["destX0"]) + offset_x,
                    float(box["destY0"]),
                    float(box["destX1"]) + offset_x,
                    float(box["destY1"]),
                ) & dst_page.rect
            except (KeyError, TypeError, ValueError):
                skipped.append({**box, "diagnostic": "formula-span-invalid"})
                continue
            if src_clip.is_empty or src_clip.width < 1 or src_clip.height < 1:
                skipped.append({**box, "diagnostic": "formula-span-empty-clip"})
                continue
            if dest_rect.is_empty or dest_rect.width < 1 or dest_rect.height < 1:
                skipped.append({**box, "diagnostic": "formula-span-empty-dest"})
                continue
            dest_rect, src_clip, guard = _shrink_for_cjk(dest_rect, src_clip, dest_chars)
            if guard == "cjk-guard-skip" or dest_rect is None:
                skipped.append({**box, "diagnostic": "formula-span-cjk-guard"})
                continue
            span_prepared.append({
                "box": box,
                "src_clip": src_clip,
                "dest_rect": dest_rect,
                "guard": guard,
            })
            continue
        clip = _rect(box["x0"], box["y0"], box["x1"], box["y1"]) & src_page.rect
        if clip.is_empty or clip.width < 2 or clip.height < 2:
            continue
        dest_rect = _rect(
            clip.x0 + offset_x,
            clip.y0,
            clip.x1 + offset_x,
            clip.y1,
        ) & dst_page.rect
        if dest_rect.is_empty:
            continue
        relaxed = _allows_chinese_overlap(box)
        blocked = False
        for rect in chinese_rects:
            if (dest_rect & rect).is_empty:
                continue
            if relaxed and _line_belongs_to_box(dest_rect, rect):
                continue
            blocked = True
            break
        if blocked:
            skipped.append({**box, "diagnostic": "overlaps-chinese-text"})
            continue
        prepared.append((clip, dest_rect))
    restored = 0
    if prepared:
        for _clip, dest_rect in prepared:
            dst_page.add_redact_annot(dest_rect, fill=(1, 1, 1))
        # 不破坏相邻图片，参数保持兼容较旧的 PyMuPDF。
        dst_page.apply_redactions(images=0)
        for clip, dest_rect in prepared:
            dst_page.show_pdf_page(dest_rect, src_doc, src_index, clip=clip, keep_proportion=False)
            restored += 1
    mask_doc = None
    masked_chars = 0
    if span_prepared:
        # 旧框已经落盘（内存页），以它为 span 校验基线。
        baseline_chars = _page_chars(dst_page)
        baseline_text = _normalize_formula(dst_page.get_text("text"))
        for item in span_prepared:
            dest_rect = item["dest_rect"]
            # 新框用 ±0.15pt redaction，盖掉字体边缘残留。
            dst_page.add_redact_annot(
                _rect(dest_rect.x0 - 0.15, dest_rect.y0 - 0.15, dest_rect.x1 + 0.15, dest_rect.y1 + 0.15),
                fill=(1, 1, 1),
            )
        dst_page.apply_redactions(images=0)
        try:
            # 所有 span 框共享一张 mask：只保留字符中心在 clip 内的字符。
            # 交叠 run（第 3 页 r1/r2 共用 Q 的上下标）会略微重影，但不会丢字；
            # 逐框 mask 反而会让后一个章的白色背景擦掉前一个章的 π 上标。
            mask_doc, masked_chars = _build_mask_doc(
                src_doc,
                src_index,
                [item["src_clip"] for item in span_prepared],
            )
            for item in span_prepared:
                dst_page.show_pdf_page(
                    item["dest_rect"],
                    mask_doc,
                    0,
                    clip=item["src_clip"],
                    keep_proportion=False,
                )
                restored += 1
        except Exception as error:  # noqa: BLE001 - 返回结构化失败，不覆盖原文件
            if mask_doc is not None:
                mask_doc.close()
            dst_doc.close()
            src_doc.close()
            return {"ok": False, "restored": 0, "reason": f"span-mask-failed: {error}"}
        verification = _verify_span_stamp(dst_page, baseline_chars, baseline_text, [item["box"] for item in span_prepared])
        if not verification.get("ok"):
            mask_doc.close()
            dst_doc.close()
            src_doc.close()
            return {"ok": False, "restored": 0, **verification}
    else:
        verification = {"ok": True}
    if mask_doc is not None:
        mask_doc.close()
    tmp = dest + ".preserve.tmp.pdf"
    dst_doc.save(tmp, garbage=3, deflate=True)
    dst_doc.close()
    src_doc.close()
    os.replace(tmp, dest)
    result = {"ok": True, "restored": restored, "skipped": skipped}
    if span_prepared:
        result["span"] = {
            "boxes": len(span_prepared),
            "maskedChars": masked_chars,
            "cjkBefore": verification.get("cjkBefore"),
            "cjkAfter": verification.get("cjkAfter"),
            "cjkGained": verification.get("cjkGained"),
            "keys": verification.get("keys", []),
        }
    return result


def main(argv: list[str]) -> int:
    if len(argv) < 2:
        print("usage: extract|stamp", file=sys.stderr)
        return 2
    cmd = argv[1]
    if cmd == "extract":
        pdf_path = argv[2]
        page_no = int(argv[3])
        include_chars = len(argv) > 4 and argv[4] == "chars"
        json.dump(extract_lines(pdf_path, page_no, include_chars), sys.stdout, ensure_ascii=False)
        return 0
    if cmd == "stamp":
        with open(argv[2], encoding="utf-8") as fh:
            payload = json.load(fh)
        json.dump(stamp_boxes(payload), sys.stdout, ensure_ascii=False)
        return 0
    print(f"unknown command {cmd}", file=sys.stderr)
    return 2


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))

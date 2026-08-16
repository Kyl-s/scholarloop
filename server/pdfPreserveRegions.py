"""从原文 PDF 抽出文本行，或把指定矩形盖回译文页。"""
from __future__ import annotations

import json
import os
import sys


def extract_lines(pdf_path: str, page_no: int) -> dict:
    import fitz

    doc = fitz.open(pdf_path)
    index = max(0, int(page_no) - 1)
    if index >= doc.page_count:
        doc.close()
        return {"width": 0, "height": 0, "lines": []}
    page = doc[index]
    lines = []
    for block in page.get_text("dict").get("blocks", []):
        if block.get("type") != 0:
            continue
        for line in block.get("lines", []):
            text = "".join(span.get("text", "") for span in line.get("spans", []))
            if not text.strip():
                continue
            x0, y0, x1, y1 = line["bbox"]
            size = 0.0
            spans = line.get("spans") or []
            if spans:
                size = float(spans[0].get("size") or 0)
            lines.append({
                "text": text,
                "x0": round(x0, 2),
                "y0": round(y0, 2),
                "x1": round(x1, 2),
                "y1": round(y1, 2),
                "size": round(size, 1),
            })
    result = {
        "width": round(page.rect.width, 2),
        "height": round(page.rect.height, 2),
        "lines": lines,
    }
    doc.close()
    return result


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
    for box in boxes:
        clip = fitz.Rect(box["x0"], box["y0"], box["x1"], box["y1"])
        clip = clip & src_page.rect
        if clip.is_empty or clip.width < 2 or clip.height < 2:
            continue
        dest_rect = fitz.Rect(
            clip.x0 + offset_x,
            clip.y0,
            clip.x1 + offset_x,
            clip.y1,
        )
        dest_rect = dest_rect & dst_page.rect
        if dest_rect.is_empty:
            continue
        prepared.append((clip, dest_rect))
    for _clip, dest_rect in prepared:
        dst_page.add_redact_annot(dest_rect, fill=(1, 1, 1))
    if prepared:
        dst_page.apply_redactions()
    restored = 0
    for clip, dest_rect in prepared:
        dst_page.show_pdf_page(dest_rect, src_doc, src_index, clip=clip, keep_proportion=False)
        restored += 1
    tmp = dest + ".preserve.tmp.pdf"
    dst_doc.save(tmp, garbage=3, deflate=True)
    dst_doc.close()
    src_doc.close()
    os.replace(tmp, dest)
    return {"ok": True, "restored": restored}


def main(argv: list[str]) -> int:
    if len(argv) < 2:
        print("usage: extract|stamp", file=sys.stderr)
        return 2
    cmd = argv[1]
    if cmd == "extract":
        pdf_path = argv[2]
        page_no = int(argv[3])
        json.dump(extract_lines(pdf_path, page_no), sys.stdout, ensure_ascii=False)
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

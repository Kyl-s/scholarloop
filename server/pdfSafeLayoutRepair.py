"""Prepare a conservative candidate PDF; never modify the input PDF."""
import collections
import json
import re
import sys
import fitz


def lines(page):
    result = []
    for block in page.get_text("rawdict")["blocks"]:
        for line in block.get("lines", []):
            chars = [c for span in line.get("spans", []) for c in span.get("chars", [])]
            if chars:
                result.append(("".join(c["c"] for c in chars), fitz.Rect(line["bbox"]), chars))
    return result


def prose(text):
    value = " ".join(text.split())
    # Only whole, ordinary English prose. Formulae, citations, links, and short
    # legitimate English fragments remain untouched.
    return (len(value) >= 60 and len(re.findall(r"[A-Za-z]{3,}", value)) >= 8
            and not re.search(r"[=∑∫±≤≥×÷√∞∂∇∆∏≈≠∈∉⊂⊃∪∩∧∨∀∃α-ωΑ-Ω^_{}\\$@]|https?://", value)
            and not re.search(r"[\u3400-\u9fff]", value))


def run(p):
    source = fitz.open(p["source"])
    dest = fitz.open(p["dest"])
    try:
        sp = source[int(p["page"]) - 1]
        dp = dest[0]
        offset = sp.rect.width if p.get("kind") == "dual" else 0
        if abs(dp.rect.width - sp.rect.width * (2 if offset else 1)) > 2 or abs(dp.rect.height - sp.rect.height) > 2:
            return {"changed": False, "reason": "page-geometry"}
        src = lines(sp)
        dst = lines(dp)
        all_chars = [c for _, _, cs in dst for c in cs]
        candidates = []
        for text, sr, _ in src:
            if not prose(text):
                continue
            expected = fitz.Rect(sr.x0 + offset, sr.y0, sr.x1 + offset, sr.y1)
            if not any(not (expected & fitz.Rect(b[0]*sp.rect.width+offset, b[1]*sp.rect.height, b[2]*sp.rect.width+offset, b[3]*sp.rect.height)).is_empty for b in p["boxes"]):
                continue
            matches = [(t, r, cs) for t, r, cs in dst if " ".join(t.split()) == " ".join(text.split()) and max(abs(r.x0-expected.x0), abs(r.y0-expected.y0), abs(r.x1-expected.x1), abs(r.y1-expected.y1)) < 2]
            if len(matches) != 1:
                continue
            _, rect, chars = matches[0]
            ids = {id(c) for c in chars}
            # Redaction removes every intersecting glyph, so exclude any area
            # touching another line, including CJK and math.
            if any(id(c) not in ids and not (rect & fitz.Rect(c["bbox"])).is_empty for c in all_chars):
                continue
            candidates.append((text, rect, chars))
        if not candidates:
            return {"changed": False, "reason": "no-safe-candidate"}
        before = collections.Counter(c["c"] for c in all_chars)
        removed = collections.Counter(c["c"] for _, _, chars in candidates for c in chars)
        for _, rect, _ in candidates:
            dp.add_redact_annot(rect, fill=False, cross_out=False)
        dp.apply_redactions(images=0, graphics=0, text=0)
        after = collections.Counter(c["c"] for _, _, chars in lines(dp) for c in chars)
        if after != before - removed:
            return {"changed": False, "reason": "text-verification-failed"}
        dest.save(p["candidate"], garbage=3, deflate=True)
        return {"changed": True, "removed": [" ".join(t.split()) for t, _, _ in candidates]}
    finally:
        source.close()
        dest.close()

if __name__ == "__main__":
    try:
        print(json.dumps(run(json.loads(sys.stdin.read())), ensure_ascii=True))
    except Exception as exc:
        print(str(exc), file=sys.stderr)
        sys.exit(1)

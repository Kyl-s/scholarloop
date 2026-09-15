import base64
import json
import sys


def encode_payload(payload):
    return json.dumps(payload, ensure_ascii=True)


def main():
    if len(sys.argv) != 4 or sys.argv[1] != "render":
        raise ValueError("用法：render <pdf> <page>")
    import fitz

    pdf_path = sys.argv[2]
    page_number = int(sys.argv[3])
    if page_number < 1:
        raise ValueError("页码必须从 1 开始")
    document = fitz.open(pdf_path)
    try:
        if page_number > len(document):
            raise ValueError("页码超出 PDF 范围")
        page = document[page_number - 1]
        blocks = []
        for block in page.get_text("dict").get("blocks", []):
            for line in block.get("lines", []):
                text = "".join(str(span.get("text", "")) for span in line.get("spans", [])).strip()
                if not text:
                    continue
                bbox = line.get("bbox", [0, 0, 0, 0])
                blocks.append({
                    "index": len(blocks),
                    "text": text[:1200],
                    "left": float(bbox[0]),
                    "top": float(bbox[1]),
                    "width": max(0.0, float(bbox[2]) - float(bbox[0])),
                    "height": max(0.0, float(bbox[3]) - float(bbox[1]))
                })
        # 低分辨率足够判断栏位和图表，且限制单页请求体大小。
        pixmap = page.get_pixmap(matrix=fitz.Matrix(1.35, 1.35), alpha=False)
        image = "data:image/png;base64," + base64.b64encode(pixmap.tobytes("png")).decode("ascii")
        print(encode_payload({
            "page": page_number,
            "pageCount": len(document),
            "textLayer": bool(blocks),
            "width": float(page.rect.width),
            "height": float(page.rect.height),
            "lines": blocks,
            "image": image
        }))
    finally:
        document.close()


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)

from math import cos, pi, sin
from pathlib import Path

from PIL import Image, ImageDraw


OUT = Path(__file__).resolve().parents[1] / "assets" / "app-v2.ico"
SIZES = [256, 128, 64, 48, 32, 16]
INK = (22, 35, 59, 255)
PAPER = (250, 251, 253, 255)


def lemniscate(size, samples=240):
    """Sampled infinity curve centered in the square."""
    scale = size * 0.285
    cx = size / 2
    cy = size / 2
    pts = []
    for i in range(samples + 1):
        t = (i / samples) * 2 * pi
        denom = 1 + sin(t) ** 2
        x = scale * cos(t) / denom
        y = scale * sin(t) * cos(t) / denom
        pts.append((cx + x, cy + y))
    return pts


def draw(size):
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    r = max(1, round(size * 0.22))
    d.rounded_rectangle((0, 0, size - 1, size - 1), radius=r, fill=INK)
    width = max(2, round(size * 0.055))
    d.line(lemniscate(size), fill=PAPER, width=width, joint="curve")
    return img


OUT.parent.mkdir(parents=True, exist_ok=True)
imgs = [draw(s) for s in SIZES]
imgs[0].save(
    OUT,
    format="ICO",
    append_images=imgs[1:],
    sizes=[(s, s) for s in SIZES],
)
print(OUT)

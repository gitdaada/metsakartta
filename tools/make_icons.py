"""Piirtää sovelluksen kuvakkeet (docs/icons/)."""
from pathlib import Path
from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parent.parent / "docs" / "icons"
OUT.mkdir(parents=True, exist_ok=True)
BG = (15, 23, 18)
COLS = [(0, 150, 50), (30, 90, 200), (214, 40, 40)]
ORANGE = (255, 122, 26)

def draw(size, safe=1.0, rounded=True):
    S = size * 4
    im = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    if rounded:
        d.rounded_rectangle([0, 0, S - 1, S - 1], radius=int(S * 0.22), fill=BG)
    else:
        d.rectangle([0, 0, S, S], fill=BG)
    c = S / 2
    k = S * 0.36 * safe
    # Kolme kuusta: nuori (vihreä), vanha (sininen), aukko (punainen maapohja)
    base_y = c + k * 0.62
    d.rectangle([c - k, base_y, c + k, base_y + k * 0.16], fill=COLS[2])
    for i, (dx, scale, col) in enumerate([(-0.55, 0.72, COLS[0]), (0.08, 1.0, COLS[1]), (0.62, 0.6, COLS[0])]):
        cx = c + dx * k
        hgt = k * 1.45 * scale
        w = k * 0.62 * scale
        for t in range(3):
            top = base_y - hgt + t * hgt * 0.26
            bot = top + hgt * 0.46
            ww = w * (0.55 + 0.25 * t)
            d.polygon([(cx, top), (cx - ww, bot), (cx + ww, bot)], fill=col)
        d.rectangle([cx - w * 0.09, base_y - hgt * 0.08, cx + w * 0.09, base_y], fill=(90, 60, 30))
    # Sijaintipiste
    r = k * 0.2
    px, py = c + k * 0.62, c - k * 0.62
    d.ellipse([px - r * 1.35, py - r * 1.35, px + r * 1.35, py + r * 1.35], fill=(255, 255, 255))
    d.ellipse([px - r, py - r, px + r, py + r], fill=ORANGE)
    return im.resize((size, size), Image.LANCZOS)

draw(192).save(OUT / "icon-192.png", optimize=True)
draw(512).save(OUT / "icon-512.png", optimize=True)
draw(512, safe=0.78, rounded=False).save(OUT / "icon-maskable-512.png", optimize=True)
ap = draw(180, rounded=False).convert("RGB")
ap.save(OUT / "apple-touch-icon.png", optimize=True)
print("ok")

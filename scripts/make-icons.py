#!/usr/bin/env python3
"""Draws fshare's app icons into mobile/assets. Every proportion comes from the golden ratio φ:

  cookie diameter  D = visible area / φ          (iOS: the whole square; Android: the 72/108 dp safe circle)
  arrow height     H = D / φ²
  shaft spacing    H / φ                         (between the two arrows)
  stroke           H / φ⁴
  arrowhead arm    H / φ³
  cookie scallops  9 lobes, depth 1 / φ⁶ of the radius

Run: python3 scripts/make-icons.py   (needs Pillow: pip install pillow)
"""
import math
import os
import sys
from PIL import Image, ImageDraw

PHI = (1 + 5 ** 0.5) / 2
OUT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), "..", "mobile", "assets")
S = 4096  # drawn large and scaled down, for smooth edges
BG = (11, 12, 10, 255)
LIME = (198, 243, 106, 255)
INK = (18, 26, 0, 255)
CLEAR = (0, 0, 0, 0)


def cookie(d, cx, cy, diameter, fill, lobes=9):
    r0, depth = diameter / 2 / (1 + PHI ** -6), PHI ** -6
    pts = []
    for i in range(1440):
        th = i / 1440 * 2 * math.pi - math.pi / 2
        r = r0 * (1 + depth * math.cos(lobes * th))
        pts.append((cx + r * math.cos(th), cy + r * math.sin(th)))
    d.polygon(pts, fill=fill)


def stroke(d, pts, w, fill):
    # a round brush dragged along the path: round caps and joins
    for (x0, y0), (x1, y1) in zip(pts, pts[1:]):
        n = int(math.hypot(x1 - x0, y1 - y0) / 3) + 1
        for i in range(n + 1):
            x, y = x0 + (x1 - x0) * i / n, y0 + (y1 - y0) * i / n
            d.ellipse((x - w / 2, y - w / 2, x + w / 2, y + w / 2), fill=fill)


def arrows(d, cx, cy, diameter, fill, which="both"):
    h = diameter / PHI ** 2  # arrow height, outside of the strokes
    gap = h / PHI  # between the two shafts
    sw = h / PHI ** 4
    reach = h / PHI ** 3 / math.sqrt(2)  # how far a 45° arrowhead arm sticks out sideways
    top, bot = cy - h / 2 + sw / 2, cy + h / 2 - sw / 2
    lx, rx = cx - gap / 2, cx + gap / 2
    if which in ("both", "up"):
        stroke(d, [(lx, bot), (lx, top)], sw, fill)  # ↑ on the left
        stroke(d, [(lx - reach, top + reach), (lx, top), (lx + reach, top + reach)], sw, fill)
    if which in ("both", "down"):
        stroke(d, [(rx, top), (rx, bot)], sw, fill)  # ↓ on the right
        stroke(d, [(rx - reach, bot - reach), (rx, bot), (rx + reach, bot - reach)], sw, fill)


def render(path, visible, bg, body, ink, size=1024, which="both"):
    im = Image.new("RGBA", (S, S), bg)
    d = ImageDraw.Draw(im)
    diameter = S * visible / PHI
    if body:
        cookie(d, S / 2, S / 2, diameter, body)
    if which:
        arrows(d, S / 2, S / 2, diameter, ink, which)
    im.resize((size, size), Image.LANCZOS).save(os.path.join(OUT, path))


ANDROID_SAFE = 72 / 108  # adaptive icons: only this circle is guaranteed visible
render("icon.png", 1, BG, LIME, INK)
render("android-icon-foreground.png", ANDROID_SAFE, CLEAR, LIME, INK)
Image.new("RGBA", (1024, 1024), BG).save(os.path.join(OUT, "android-icon-background.png"))
render("android-icon-monochrome.png", ANDROID_SAFE, CLEAR, (255, 255, 255, 255), CLEAR)  # themed icons: arrows cut out
render("splash-icon.png", PHI, CLEAR, LIME, INK)  # cookie fills the image; the splash sizes it
render("favicon.png", 1, BG, LIME, INK, 48)
# the animated splash moves these separately; stacked, they're splash-icon.png exactly
render("splash-cookie.png", PHI, CLEAR, LIME, INK, which=None)
render("splash-up.png", PHI, CLEAR, None, INK, which="up")
render("splash-down.png", PHI, CLEAR, None, INK, which="down")
print("icons written to", os.path.abspath(OUT))


# Icon Composer layers (iOS Liquid Glass): same geometry on a 1024 canvas, one SVG per layer.
def svgs(out, size=1024):
    os.makedirs(out, exist_ok=True)
    c, diameter = size / 2, size / PHI
    r0, depth = diameter / 2 / (1 + PHI ** -6), PHI ** -6
    pts = []
    for i in range(720):
        th = i / 720 * 2 * math.pi - math.pi / 2
        r = r0 * (1 + depth * math.cos(9 * th))
        pts.append(f"{c + r * math.cos(th):.2f},{c + r * math.sin(th):.2f}")
    h = diameter / PHI ** 2
    gap, sw, reach = h / PHI, h / PHI ** 4, h / PHI ** 3 / math.sqrt(2)
    top, bot = c - h / 2 + sw / 2, c + h / 2 - sw / 2
    lx, rx = c - gap / 2, c + gap / 2
    f = lambda v: f"{v:.2f}"
    up = f"M{f(lx)} {f(bot)}V{f(top)}M{f(lx - reach)} {f(top + reach)}L{f(lx)} {f(top)}L{f(lx + reach)} {f(top + reach)}"
    down = f"M{f(rx)} {f(top)}V{f(bot)}M{f(rx - reach)} {f(bot - reach)}L{f(rx)} {f(bot)}L{f(rx + reach)} {f(bot - reach)}"
    head = f'<svg xmlns="http://www.w3.org/2000/svg" width="{size}" height="{size}" viewBox="0 0 {size} {size}">'
    stroke = f'fill="none" stroke="#121A00" stroke-width="{f(sw)}" stroke-linecap="round" stroke-linejoin="round"'
    files = {
        "1-background.svg": f'{head}<rect width="{size}" height="{size}" fill="#0B0C0A"/></svg>',
        "2-cookie.svg": f'{head}<polygon points="{" ".join(pts)}" fill="#C6F36A"/></svg>',
        "3-arrows.svg": f'{head}<path d="{up}{down}" {stroke}/></svg>',
    }
    for name, body in files.items():
        with open(os.path.join(out, name), "w") as fh:
            fh.write(body + "\n")
    print("icon composer layers written to", os.path.abspath(out))


svgs(os.path.join(os.path.dirname(__file__), "..", "design", "icon-composer"))


# Raster icons from the Liquid Glass design (mobile/assets/fshare.icon), rendered by Xcode's ictool.
# Android can't draw glass live, so it gets the render: the adaptive foreground is the render's
# centre, faded into the background colour (which the adaptive background layer repeats exactly).
ICTOOL = "/Applications/Xcode.app/Contents/Applications/Icon Composer.app/Contents/Executables/ictool"


def glass():
    import subprocess
    import tempfile

    if not os.path.exists(ICTOOL):
        print("Xcode's ictool not found; kept the flat PNG icons")
        return
    src = os.path.join(OUT, "fshare.icon")
    tmp = os.path.join(tempfile.mkdtemp(), "glass.png")
    subprocess.run([ICTOOL, src, "--export-image", "--output-file", tmp, "--platform", "iOS",
                    "--rendition", "Default", "--width", "1024", "--height", "1024", "--scale", "1"],
                   check=True, capture_output=True)
    art = Image.open(tmp).convert("RGBA")
    flat = Image.new("RGBA", art.size, BG)  # the render's corners are transparent
    flat.alpha_composite(art)

    # the cookie and its glow sit well inside this circle; past it the render is plain background
    n = 1024
    mask = Image.new("L", (n, n), 0)
    px = mask.load()
    inner, outer = n * 0.40, n * 0.47
    for y in range(n):
        for x in range(n):
            r = math.hypot(x - n / 2, y - n / 2)
            px[x, y] = 255 if r <= inner else 0 if r >= outer else int(255 * (outer - r) / (outer - inner))
    centre = flat.copy()
    centre.putalpha(mask)
    # square icons: just the glass mark on plain background, without the render's rounded-corner rim
    square = Image.new("RGBA", (n, n), BG)
    square.alpha_composite(centre)
    square.save(os.path.join(OUT, "icon.png"))
    square.resize((48, 48), Image.LANCZOS).save(os.path.join(OUT, "favicon.png"))
    k = round(n * ANDROID_SAFE)  # same safe-zone scale as the flat foreground
    fg = Image.new("RGBA", (n, n), CLEAR)
    fg.alpha_composite(centre.resize((k, k), Image.LANCZOS), ((n - k) // 2, (n - k) // 2))
    fg.save(os.path.join(OUT, "android-icon-foreground.png"))
    print("glass icons written (icon.png, favicon.png, android-icon-foreground.png)")


glass()

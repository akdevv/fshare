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


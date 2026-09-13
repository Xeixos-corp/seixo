"""Builds the launch screen image from the app icon.

The icon is a square with no transparency, as iOS requires -- an app icon
containing alpha is rejected. iOS rounds it itself on the home screen, but the
launch screen draws whatever image it is given, square corners and all.

That went unnoticed because the icon's background is almost exactly the launch
screen's (#EDEDED against #EBEBEB), so the top edge is invisible. The bottom is
not: the pebble's shadow is painted into the image and is darker than either,
so the two bottom corners showed as dark squares while the top two appeared
rounded. They were never rounded -- they were camouflaged.

So this cuts the same shape iOS uses and leaves the outside transparent, which
makes the launch screen right on any background rather than only on the one it
happens to match.

The curve is a superellipse, not a circular corner: that is what Apple's icon
mask actually is, and a plain rounded rectangle next to it reads as slightly
pinched at the corners. Rendered at four times the size and scaled down, so the
edge is smooth rather than stepped.

Run from the app directory:  python scripts/make-splash-icon.py
"""

import os

from PIL import Image

SOURCE = os.path.join(os.path.dirname(__file__), '..', 'assets', 'icon.png')
TARGET = os.path.join(os.path.dirname(__file__), '..', 'assets', 'splash-icon.png')

# Apple's icon mask, as measured from the templates: the corner reaches about
# 22.4% of the side, and the curve is a superellipse of roughly this exponent.
RADIUS_RATIO = 0.2237
EXPONENT = 5.0
SUPERSAMPLE = 4


def mask(size):
    """A superellipse the size of the icon, antialiased by supersampling."""
    big = size * SUPERSAMPLE
    radius = big * RADIUS_RATIO
    layer = Image.new('L', (big, big), 0)
    pixels = layer.load()

    # Only the corner squares need the curve; everything between them is solid,
    # which keeps this to a few million cheap comparisons instead of one per
    # pixel of a 4096-square image.
    for x in range(big):
        for y in range(big):
            dx = radius - x if x < radius else (x - (big - 1 - radius) if x > big - 1 - radius else 0)
            dy = radius - y if y < radius else (y - (big - 1 - radius) if y > big - 1 - radius else 0)
            if dx <= 0 or dy <= 0:
                pixels[x, y] = 255
                continue
            if (dx / radius) ** EXPONENT + (dy / radius) ** EXPONENT <= 1.0:
                pixels[x, y] = 255

    return layer.resize((size, size), Image.LANCZOS)


def main():
    icon = Image.open(SOURCE).convert('RGBA')
    if icon.width != icon.height:
        raise SystemExit(f'expected a square icon, got {icon.size}')

    icon.putalpha(mask(icon.width))
    icon.save(TARGET)
    print(f'{os.path.basename(TARGET)}  {icon.width}x{icon.height}  {os.path.getsize(TARGET) / 1024:.0f} KB')


if __name__ == '__main__':
    main()

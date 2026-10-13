# Draws static/og.png, the link preview: PAD in a box of box-drawing
# characters in the VGA font, over the background texture, as nassu.online's.
# No domain, so every instance can use it. python3 scripts/og.py (Pillow).
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
W, H = 1200, 630
SCALE = 6
INK = (0xFF, 0x8F, 0xC8)
TEXT = "PAD"
LINES = [
    "╔" + "═" * (len(TEXT) + 2) + "╗",
    "║ " + TEXT + " ║",
    "╚" + "═" * (len(TEXT) + 2) + "╝",
]

# The font at its own size, unsmoothed, then scaled by a whole number.
font = ImageFont.truetype(str(ROOT / "static/fonts/WebPlus_IBM_VGA_9x16.woff"), 16)
small = Image.new("RGBA", (9 * len(LINES[0]), 16 * len(LINES)), (0, 0, 0, 0))
draw = ImageDraw.Draw(small)
draw.fontmode = "1"
for i, line in enumerate(LINES):
    draw.text((0, 16 * i), line, font=font, fill=INK)
box = small.resize((small.width * SCALE, small.height * SCALE), Image.NEAREST)

out = Image.new("RGB", (W, H))
tile = Image.open(ROOT / "static/bg.png").convert("RGB")
for x in range(0, W, tile.width):
    for y in range(0, H, tile.height):
        out.paste(tile, (x, y))
# Black inside the frame only: the glyphs' cells stick out past its lines.
at = ((W - box.width) // 2, (H - box.height) // 2)
left, top, right, bottom = box.getbbox()
out.paste((0, 0, 0), (at[0] + left, at[1] + top, at[0] + right, at[1] + bottom))
out.paste(box, at, box)
out.save(ROOT / "static/og.png", optimize=True)

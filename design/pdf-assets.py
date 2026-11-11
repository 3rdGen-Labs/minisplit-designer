"""Write PNG copies of the unit artwork for the PDF export (pdf-lib can't embed WebP).

Run from the repo root after changing app/public/units/: python3 design/pdf-assets.py
"""
from pathlib import Path
from PIL import Image

src = Path("app/public/units")
out = Path("app/src/lib/pdf/assets")
out.mkdir(parents=True, exist_ok=True)
for f in sorted(src.glob("*.webp")):
    im = Image.open(f).convert("RGBA")
    im.thumbnail((260, 260), Image.LANCZOS)
    im.quantize(colors=128, method=Image.FASTOCTREE).save(out / f"{f.stem}.png", optimize=True)
    print(f.stem, im.size)

"""Bundle src/ into a single index.html that opens with a double-click (and serves as the GitHub Pages site)."""
from pathlib import Path

root = Path(__file__).parent
src = root / "src"
html = (src / "index.html").read_text()
parts = {
    "/*GIFENC*/": (src / "gifenc.min.js").read_text(),
    "/*WORKER*/": (src / "worker.js").read_text(),
    "/*PLAYER*/": (src / "player.js").read_text(),
    "/*COLOR*/": (src / "colorpicker.js").read_text(),
    "/*APP*/": (src / "app.js").read_text(),
}
for key, code in parts.items():
    assert "</script" not in code.lower(), key
    html = html.replace(key, code, 1)
out = root / "index.html"
out.write_text(html)
print(f"wrote {out.name} ({len(html) / 1024:.0f} KB)")

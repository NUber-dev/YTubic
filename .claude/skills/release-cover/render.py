"""Render a release cover from the app's real UI. See SKILL.md.

python .claude/skills/release-cover/render.py --version 0.6.0 --view settings:playback --bg sea
"""
import argparse
import http.server
import json
import os
import shutil
import socketserver
import subprocess
import sys
import tempfile
import threading
from pathlib import Path
from urllib.parse import quote

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]  # the project root (.claude/skills/release-cover -> ../../..)

CHROME_CANDIDATES = [
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
]

ap = argparse.ArgumentParser()
ap.add_argument("--version", required=True, help="e.g. 0.6.0; names the output")
ap.add_argument("--view", default="settings:playback")
ap.add_argument("--bg", default="sea", help="sea | ember | amber | dusk")
ap.add_argument("--state", default='{"crossfadeSec":6,"normalizeVolume":false,"eqEnabled":true,"eqPreset":"vocal","monoAudio":false}')
ap.add_argument("--move", default="", help='"<Row title>|<Before row title>"')
ap.add_argument("--crop", default="260,68,1100,550")
ap.add_argument("--rect", default="340,130,920,640")
ap.add_argument("--out", default="")
ap.add_argument("--chrome", default="")
ap.add_argument("--keep", action="store_true", help="keep the renders next to the output")
args = ap.parse_args()

chrome = args.chrome or next((c for c in CHROME_CANDIDATES if os.path.exists(c)), "")
if not chrome:
    sys.exit("No Chrome/Edge found; pass --chrome")

out = Path(args.out) if args.out else ROOT / "public" / "whats-new" / f"{args.version}.jpg"
work = Path(tempfile.mkdtemp(prefix="ytubic-cover-"))
dist = work / "dist"

entry = ROOT / "src" / "cover-entry.tsx"
html = ROOT / "cover.html"
cfg = ROOT / "vite.cover.config.ts"
try:
    # 1. stage the temporary entry files in the project
    shutil.copy(HERE / "cover-entry.tsx", entry)
    shutil.copy(HERE / "vite.cover.config.ts", cfg)
    html.write_text(
        '<!doctype html>\n<html lang="en" class="dark">\n  <head>\n    <meta charset="UTF-8" />\n'
        '    <meta name="viewport" content="width=device-width, initial-scale=1.0" />\n'
        "    <title>YTubic cover</title>\n  </head>\n  <body>\n    <div id=\"root\"></div>\n"
        '    <script type="module" src="/src/cover-entry.tsx"></script>\n  </body>\n</html>\n',
        encoding="utf-8",
    )

    # 2. build
    env = {**os.environ, "COVER_OUT": str(dist)}
    subprocess.run(
        ["npx", "vite", "build", "--config", str(cfg)],
        cwd=ROOT, env=env, check=True, shell=(os.name == "nt"),
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )

    # 3. serve + screenshot, with and without the subject
    class Quiet(http.server.SimpleHTTPRequestHandler):
        def log_message(self, *a):
            pass

    handler = lambda *a, **k: Quiet(*a, directory=str(dist), **k)
    with socketserver.TCPServer(("127.0.0.1", 0), handler) as srv:
        port = srv.server_address[1]
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        query = f"view={quote(args.view)}&bg={quote(args.bg)}&state={quote(args.state)}"
        if args.move:
            query += f"&move={quote(args.move)}"
        shots = {}
        for name, extra in (("subject", ""), ("backdrop", "&nodialog=1")):
            png = work / f"{name}@2x.png"
            subprocess.run(
                [chrome, "--headless=new", "--disable-gpu", "--hide-scrollbars",
                 "--window-size=1600,900", "--force-device-scale-factor=2",
                 "--virtual-time-budget=4000", f"--screenshot={png}",
                 f"http://127.0.0.1:{port}/cover.html?{query}{extra}"],
                check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            )
            shots[name] = png
        srv.shutdown()

    # 4. grade
    out.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        [sys.executable, str(HERE / "grade.py"), str(shots["subject"]), str(shots["backdrop"]),
         str(out), "--crop", args.crop, "--rect", args.rect],
        check=True,
    )
    if args.keep:
        for name, png in shots.items():
            shutil.copy(png, out.with_name(f"{out.stem}-{name}@2x.png"))
    print(f"cover: {out} ({out.stat().st_size // 1024} KB)")
finally:
    for f in (entry, html, cfg):
        if f.exists():
            f.unlink()
    shutil.rmtree(work, ignore_errors=True)

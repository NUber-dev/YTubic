"""Grade a release cover from two renders: the subject (dialog) stays
pixel-sharp inside its rounded rect over the backdrop render, then soft
gaussian depth of field with a high focus, colour bloom, a hair of
chromatic aberration, light grain, a faint vignette. Writes 1600x800.

grade.py <with-subject.png> <backdrop.png> <out.jpg> --crop x,y,w,h --rect x,y,w,h
(crop and rect in 1x viewport coordinates of a 1600x900 @2x render)"""
import argparse
import numpy as np
from PIL import Image, ImageDraw, ImageEnhance, ImageFilter

# ---- tuning knobs ------------------------------------------------------
FOCUS = (0.5, 0.4)          # focus centre, as fractions of the crop
FOCUS_EXTENT = (0.62, 0.75)  # ellipse radii (fractions of W, H)
RADII = [0, 1, 2, 3, 5, 8]   # blur layers, px at 2x; the last = strongest
RAMP = (0.5, 0.6, 1.5)       # start, width, curve of the falloff
BLOOM = (35, 90, 170, 42, 1.0)  # chroma floor, chroma range, brightness floor, blur, strength
CA = 0.0015                  # chromatic aberration scale
GRAIN = 1.3
SATURATION = 1.12
SHADOW = (70, 0.55)          # dialog drop shadow blur, strength
OUT_SIZE = (1600, 800)

ap = argparse.ArgumentParser()
ap.add_argument("subject")
ap.add_argument("backdrop")
ap.add_argument("out")
ap.add_argument("--crop", default="260,68,1100,550")
ap.add_argument("--rect", default="340,130,920,640")
ap.add_argument("--radius", type=int, default=20, help="subject corner radius, 1x px")
args = ap.parse_args()

S = 2
x0, y0, w, h = [int(v) for v in args.crop.split(",")]
box = (x0 * S, y0 * S, (x0 + w) * S, (y0 + h) * S)
dlg = Image.open(args.subject).convert("RGB").crop(box)
bg = Image.open(args.backdrop).convert("RGB").crop(box)
W, H = dlg.size

DX, DY, DW, DH = [int(v) for v in args.rect.split(",")]
rect = ((DX - x0) * S, (DY - y0) * S, (DX - x0 + DW) * S, (DY - y0 + DH) * S)
mask = Image.new("L", (W, H), 0)
ImageDraw.Draw(mask).rounded_rectangle(rect, radius=args.radius * S, fill=255)
m = np.asarray(mask).astype(np.float32)[..., None] / 255
shadow = np.asarray(mask.filter(ImageFilter.GaussianBlur(radius=SHADOW[0]))).astype(np.float32) / 255
back = np.asarray(bg).astype(np.float32) * (1 - SHADOW[1] * shadow[..., None])
a = back * (1 - m) + np.asarray(dlg).astype(np.float32) * m

# ---- depth of field: gaussian layers blended by a radial circle of confusion
yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)

def gauss(rad):
    n = rad * 3
    y, x = np.mgrid[-n : n + 1, -n : n + 1].astype(np.float32)
    k = np.exp(-(x * x + y * y) / (2 * rad * rad))
    return k / k.sum()

def fft_conv(img, k):
    kh, kw = k.shape
    fh, fw = H + kh - 1, W + kw - 1
    r = np.fft.irfft2(np.fft.rfft2(img, s=(fh, fw)) * np.fft.rfft2(k, s=(fh, fw)), s=(fh, fw))
    return r[kh // 2 : kh // 2 + H, kw // 2 : kw // 2 + W]

r2 = np.sqrt(((xx - W * FOCUS[0]) / (W * FOCUS_EXTENT[0])) ** 2 + ((yy - H * FOCUS[1]) / (H * FOCUS_EXTENT[1])) ** 2)
coc = np.clip((r2 - RAMP[0]) / RAMP[1], 0, 1) ** RAMP[2] * RADII[-1]

lin = (a / 255.0) ** 2.2
layers = [lin]
for rad in RADII[1:]:
    k = gauss(rad)
    layers.append(np.stack([fft_conv(lin[..., c], k) for c in range(3)], axis=-1))
outlin = np.zeros_like(lin)
for i in range(len(RADII) - 1):
    lo, hi = RADII[i], RADII[i + 1]
    band = ((coc >= lo) & (coc < hi)) if i < len(RADII) - 2 else (coc >= lo)
    t = np.where(band, np.clip((coc - lo) / (hi - lo), 0, 1), 0)[..., None]
    outlin += np.where(band[..., None], layers[i] * (1 - t) + layers[i + 1] * t, 0)
a = np.clip(outlin, 0, 1) ** (1 / 2.2) * 255

# ---- bloom on colour, not on white
cf, cr, bf, br, bs = BLOOM
mx = a.max(axis=-1)
chroma = mx - a.min(axis=-1)
bm = (np.clip((chroma - cf) / cr, 0, 1) * np.clip(mx / bf, 0, 1))[..., None]
glow = Image.fromarray(np.clip(a * bm, 0, 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(radius=br))
a = 255 - (255 - a) * (255 - np.asarray(glow).astype(np.float32) * bs) / 255

# ---- chromatic aberration: red scaled out, blue scaled in
def scaled(ch, s):
    img = Image.fromarray(np.clip(ch, 0, 255).astype(np.uint8))
    nw, nh = int(round(W * s)), int(round(H * s))
    img = img.resize((nw, nh), Image.BICUBIC)
    ox, oy = (nw - W) // 2, (nh - H) // 2
    if s >= 1:
        return np.asarray(img.crop((ox, oy, ox + W, oy + H))).astype(np.float32)
    canvas = Image.new("L", (W, H))
    canvas.paste(img, (-ox, -oy))
    return np.asarray(canvas).astype(np.float32)

a = np.stack([scaled(a[..., 0], 1 + CA), a[..., 1], scaled(a[..., 2], 1 - CA)], axis=-1)

# ---- grain, vignette
rng = np.random.default_rng(7)
a = a + rng.normal(0, GRAIN, size=(H, W, 1)).astype(np.float32)
rv = np.sqrt(((xx - W * 0.5) / (W * 0.55)) ** 2 + ((yy - H * 0.48) / (H * 0.7)) ** 2)
a = a * (1 - 0.14 * np.clip((rv - 0.8) / 0.6, 0, 1) ** 1.5)[..., None]

final = Image.fromarray(np.clip(a, 0, 255).astype(np.uint8))
final = ImageEnhance.Color(final).enhance(SATURATION).resize(OUT_SIZE, Image.LANCZOS)
final.save(args.out, quality=93, subsampling=0)
print(args.out, final.size)

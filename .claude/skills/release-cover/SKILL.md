---
name: release-cover
description: Render the What's New / release-notes cover for a YTubic release from the app's REAL UI (settings dialog or any route), then grade it (ambient palette, soft depth of field, colour bloom, chromatic aberration, grain). Use when preparing a release cover, "обложка для релиза", or a hero image for whats-new.ts.
---

# Release cover

Produces `public/whats-new/<version>.jpg` (1600x800, 2:1) the way 0.5.0's
was made: the real React components rendered by headless Chrome, not a
hand-drawn lookalike, so the cover is pixel-true to the app.

## How it works

1. `cover-entry.tsx` is copied into `src/` and built by `vite.cover.config.ts`
   into a scratch dir. It mounts the app's shell pieces (theme, query client,
   tooltips, the ambient backdrop) and one subject chosen by URL:
   - `?view=settings:<tab>` opens `SettingsDialog` on that tab
     (`general | playback | appearance | storage | integrations`).
   - `?bg=<palette>` picks the ambient wash: `sea` (0.5.0, teal/blue with
     lava-lamp blobs), `ember` (accent red, no blue), `amber`, `dusk`.
   - `?move=<Row title>|<Before row title>` moves one SettingRow before another
     in the DOM, for staging only (0.5.0 put Volume Normalization under the
     equalizer). Omit unless a row order looks wrong in the shot.
   - `?nodialog=1` renders the backdrop alone (the grade needs both).
   - `?state=<json>` merges into `usePlaybackSettings` (e.g. crossfade, EQ
     preset) so the subject shows meaningful values.
2. `render.py` builds once, serves the build with `python -m http.server`,
   screenshots both variants with Chrome at 1600x900 @2x, runs `grade.py`,
   writes the JPEG, and removes the temporary files from the project.
3. `grade.py` composites the sharp dialog over the backdrop (adds its drop
   shadow), then applies soft gaussian depth of field with the focus high on
   the window (title row and top edge stay crisp), colour bloom (chroma-gated,
   so white text does not glow), 0.15% chromatic aberration, light grain,
   a faint vignette, +12% saturation.

## Run

```bash
python .claude/skills/release-cover/render.py --version 0.6.0 --view settings:playback --bg sea
```

Options: `--crop x,y,w,h` (1x viewport coords, default `260,68,1100,550`
frames the 920x640 centred settings dialog with its bottom cut), `--rect
x,y,w,h` (the subject's box in 1x coords for the mask, default the settings
dialog `340,130,920,640`), `--state '{"crossfadeSec":6,"eqEnabled":true,"eqPreset":"vocal"}'`,
`--move "Volume Normalization|Mono Audio"`, `--out path.jpg` to write
elsewhere than `public/whats-new/`.

Chrome is looked up at the usual install paths; `--chrome` overrides.

## Then

- Add `image: "/whats-new/<version>.jpg"` to the release entry in
  `src/lib/whats-new.ts`.
- The GitHub notes get the same picture at the top:
  `![YTubic X.Y.Z](https://raw.githubusercontent.com/NUber-dev/YTubic/vX.Y.Z/public/whats-new/X.Y.Z.jpg)`
  (the tag must include the image, so commit it before tagging).
- Show the user the JPEG before wiring it in; they tune palette and blur by
  eye. What they rejected in 0.5.0: perspective tilt, bloom on white, strong
  or hard-edged DoF, orange/red washes for that release.

## Tuning knobs (grade.py)

- Focus and strength: `FOCUS = (0.5, 0.4)`, `RADII = [0,1,2,3,5,8]`,
  `RAMP = (0.5, 0.6, 1.5)` (start, width, curve). Smaller last radius = milder.
- Bloom: `BLOOM = (35, 90, 170, 42, 1.0)` (chroma floor, chroma range,
  brightness floor, blur radius, strength).
- `ambient opacity` lives in cover-entry.tsx (`opacity-[0.72]`; the app itself
  uses 0.3, which is too faint for a still).

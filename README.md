# PNG → GIF

Turn a PNG image sequence into an animated GIF, right in the browser. Files are never uploaded.

**Use it:** open `index.html` in a browser (double-click works), or visit the GitHub Pages site.

## Features

- Drag and drop PNG files or a whole folder (natural filename order: `frame_2` before `frame_10`)
- Frame rate (default 30 fps), with exact timing despite GIF's 1/100 s delay unit
- Output width / height in px or %, with aspect-ratio lock
- Merge duplicate frames: identical consecutive frames become one longer frame
- Target file size: shrinks the GIF to fit under a size you set
- Live file size estimate
- Preview: click to pause / play, click a frame to jump to it
- Transparent PNGs: keep transparency or fill with a background color
- Large sequences (e.g. 1080p × 300) are processed one frame at a time in Web Workers

## Development

Source lives in `src/`. After editing, rebuild the single-file app:

```bash
python3 build.py
```

| File | Role |
| --- | --- |
| `src/index.html` | Layout and styles |
| `src/app.js` | UI, settings, frame planning, target-size fitting |
| `src/worker.js` | Frame analysis, size estimates, GIF encoding (Web Worker) |
| `src/player.js` | GIF decoder/player used for the preview |
| `src/gifenc.min.js` | [gifenc](https://github.com/mattdesl/gifenc) encoder (MIT) |

See `THIRD_PARTY_LICENSES.md` for bundled library licenses.

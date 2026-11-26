# Cliper

Trim and split a video or a PNG sequence, then export it as GIF, MP4 or PNG — right in the browser. Files are never uploaded.

**Use it:** https://yyoungsuh-dot.github.io/cliper/ (Chrome: ⋮ → Cast, save, and share → Install page as app)

## Features

- Open a video (MP4, MOV, WebM) or PNG files / a folder of PNGs (natural filename order)
- Export as **GIF**, **MP4** (H.264) or **PNG** frames (ZIP)
- Clips: trim with iPhone-style handles on the frame strip, split at the current frame, edit ranges by number; each clip exports separately (`name_001-040.gif`)
- Frame rate (video sources start at their own frame rate), output size in px with aspect-ratio lock
- GIF: merge duplicate frames, fit under a target file size
- MP4: target file size sets the bitrate
- Transparent sources: keep transparency (GIF/PNG) or fill with a color from the color picker
- Preview: click to pause / play, click a frame to jump to it

## Development

Source lives in `src/`. After editing, rebuild the app:

```bash
python3 build.py
```

| File | Role |
| --- | --- |
| `src/index.html` | Layout and styles |
| `src/app.js` | UI, clips, planning, export and download |
| `src/worker.js` | Decoding, analysis, size estimates, GIF / MP4 / PNG encoding (Web Worker) |
| `src/player.js` | Preview players for GIF, PNG frames and MP4 |
| `src/colorpicker.js` | Background color picker |
| `src/gifenc.min.js` | [gifenc](https://github.com/mattdesl/gifenc) GIF encoder (MIT) |
| `vendor/mediabunny.min.js` | [Mediabunny](https://github.com/Vanilagy/mediabunny) video decode / MP4 encode (MPL-2.0), loaded by the worker |

Video features need the page served over http(s) (GitHub Pages or a local server); opening `index.html` from disk supports PNG input only.

See `THIRD_PARTY_LICENSES.md` for bundled library licenses.

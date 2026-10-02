# Training guide

The staff training guide for the platform, in English and French. Each version lives in its own folder (`v01/`, `v02/`, …) so older versions stay available.

## Files in a version folder

| File | What it is |
|---|---|
| `chirhuza-training-guide-vNN-en.pdf` / `-fr.pdf` | The finished guides to share |
| `content-en.html` / `content-fr.html` | The text of each chapter: edit these |
| `build.py` | The diagrams (SVG, with labels in both languages) and the PDF build |
| `style.css` | The print layout (A4, page numbers, footer) |
| `guide-en.html` / `guide-fr.html` | Generated: don't edit by hand |

Diagrams are added in the content with a placeholder such as `{{diagram:flow}}`. The available names are listed in `DIAGRAMS` in `build.py`.

## Regenerate the PDFs

Needs Python 3 and Google Chrome (used headless to print to PDF).

```sh
python3 docs/training/v01/build.py
```

## Start a new version (e.g. v02)

1. Copy the folder: `cp -R docs/training/v01 docs/training/v02`.
2. In `v02/build.py`, set `VERSION = "v02"`. In `v02/style.css`, change the footer text `v01` to `v02`.
3. Update the cover (date, "Version 02") and the chapters in **both** `content-en.html` and `content-fr.html`. Use the exact button and field names from `messages/en.json` and `messages/fr.json`.
4. Update or add diagrams in `build.py` (labels in both `L["en"]` and `L["fr"]`).
5. Run `python3 docs/training/v02/build.py` and check both PDFs.

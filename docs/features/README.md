# Features guide

A plain-language PDF that describes every feature of the platform, in English and French. Staff download it from **Features guide (PDF)** at the bottom of the side menu. It is a reference. The step-by-step course is the training guide in `docs/training/`.

## Files

| File | What it is |
|---|---|
| `content-en.html` / `content-fr.html` | The text. Edit these, always both together. |
| `style.css` | The print layout (A4), the same look as the training guide. |
| `build.py` | Builds the PDFs with headless Google Chrome. |
| `public/docs/chirhuza-features-en.pdf` / `-fr.pdf` | The built PDFs that the app serves. Commit them. |

## Writing a section

- One `<h2 id="...">` per category, numbered, and listed in the contents (`<ol class="toc">`). Every live module in `src/lib/shell-modules.ts` needs a section whose id is the module key. Both files have the same ids in the same order. A test checks this (`src/lib/features-guide.test.ts`).
- Use the same blocks in every section: **What it is**, **Where to find it**, **How it works**, **Who can use it**, **Good to know** (`<div class="block"><h4>…</h4>…</div>`). Leave out a block when it adds nothing.
- Short sentences and simple words for non-technical staff. No code.
- Put screen words in `<span class="ui">…</span>`, copied exactly from `messages/en.json` / `messages/fr.json`.
- The cover's date comes from `{{updated}}`, filled in by the build.

## Rebuild

Needs Python 3 and Google Chrome.

```sh
python3 docs/features/build.py
```

Open both PDFs to check them, then commit the content files and the PDFs together.

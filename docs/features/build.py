#!/usr/bin/env python3
"""
Builds the CHIRHUZA GROUP features guide in English and French.

  content-en.html / content-fr.html  -> the text (HTML body), one <h2 id> per category
  style.css                          -> print layout (A4), shared with the training guide's look
  this file                          -> assembly + PDF render (headless Google Chrome)

The PDFs go straight to public/docs/, where the app serves them (the
"Features guide (PDF)" link in the side menu), so a deploy always ships
the latest guide. {{updated}} in the content becomes today's date.

Run:  python3 docs/features/build.py
Out:  public/docs/chirhuza-features-en.pdf / -fr.pdf
"""

import datetime
import html
import pathlib
import subprocess
import tempfile

HERE = pathlib.Path(__file__).resolve().parent
OUT = HERE.parent.parent / "public" / "docs"
CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

TITLES = {"en": "CHIRHUZA GROUP Ltd — Features guide", "fr": "CHIRHUZA GROUP Ltd — Guide des fonctionnalités"}
FOOTERS = {"en": "CHIRHUZA GROUP Ltd · Features guide", "fr": "CHIRHUZA GROUP Ltd · Guide des fonctionnalités"}
MONTHS = {
    "en": ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"],
    "fr": ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"],
}


def updated(lang: str) -> str:
    today = datetime.date.today()
    month = MONTHS[lang][today.month - 1]
    return f"{month} {today.day}, {today.year}" if lang == "en" else f"{today.day} {month} {today.year}"


def build(lang: str, folder: pathlib.Path) -> pathlib.Path:
    content = (HERE / f"content-{lang}.html").read_text(encoding="utf-8").replace("{{updated}}", updated(lang))
    css = (HERE / "style.css").read_text(encoding="utf-8").replace(FOOTERS["en"], FOOTERS[lang])
    page = (
        f"<!doctype html><html lang='{lang}'><head><meta charset='utf-8'>"
        f"<title>{html.escape(TITLES[lang])}</title><style>{css}</style></head>"
        f"<body>{content}</body></html>"
    )
    out = folder / f"features-{lang}.html"
    out.write_text(page, encoding="utf-8")
    return out


def render(html_path: pathlib.Path, lang: str) -> pathlib.Path:
    OUT.mkdir(parents=True, exist_ok=True)
    pdf = OUT / f"chirhuza-features-{lang}.pdf"
    subprocess.run(
        [CHROME, "--headless", "--disable-gpu", "--no-pdf-header-footer", f"--print-to-pdf={pdf}", html_path.as_uri()],
        check=True,
        capture_output=True,
    )
    return pdf


if __name__ == "__main__":
    with tempfile.TemporaryDirectory() as tmp:
        for lang in ("en", "fr"):
            pdf = render(build(lang, pathlib.Path(tmp)), lang)
            print("built", pdf.relative_to(HERE.parent.parent))

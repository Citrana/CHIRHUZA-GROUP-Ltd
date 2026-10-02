#!/usr/bin/env python3
"""
Builds the CHIRHUZA GROUP training guide (v01) in English and French.

  content-en.html / content-fr.html  -> the text of each guide (HTML body)
  style.css                          -> shared print layout (A4)
  this file                          -> diagrams (SVG) + assembly + PDF render

Diagrams are written once here and drawn with each language's labels; in
the content files, {{diagram:name}} marks where each one goes.

Run:  python3 docs/training/v01/build.py
Out:  chirhuza-training-guide-v01-en.pdf / -fr.pdf (+ guide-en/fr.html)
"""

import html
import pathlib
import re
import subprocess
import sys

HERE = pathlib.Path(__file__).resolve().parent
VERSION = "v01"
CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

INK = "#1a2e22"
ACCENT = "#c8e6a0"
MID = "#3e5c43"
SOFT = "#eef5e6"
LINE = "#9fb59f"
WARN = "#b54708"
WARN_BG = "#fdf0e3"
RED = "#b42318"
RED_BG = "#fde8e7"

# --------------------------------------------------------------- labels

L = {
    "en": {
        "flow": [
            ("Requisition", "Shop asks for stock", "Chief Sales Admin"),
            ("Approval", "Chief Admin approves", "Chief Admin"),
            ("Purchase batch", "Buyer buys abroad", "Chief Inventory Admin"),
            ("Mark as purchased", "Lines and costs locked", "Chief Inventory Admin"),
            ("Approval", "Chief Admin approves the batch", "Chief Admin"),
            ("Shipped → Arrived", "On the way, then in Goma", "Buyer / Goma team"),
            ("Receiving in Goma", "Count good, damaged, missing", "Manager / Chief Sales"),
            ("Stock at the business", "Sellable lots", ""),
            ("Distribution", "Send to a shop or person", "Manager / Chief Sales"),
            ("Approval", "Chief Admin approves", "Chief Admin"),
            ("Stock in the shop", "Ready to sell", ""),
            ("Sale", "Recorded on the phone", "Sales Agent"),
        ],
        "flowEnd": "Analytics",
        "req": ["Draft", "Submitted", "Approved", "Purchasing", "Closed"],
        "reqBranch": "Rejected → revise and resubmit",
        "batch": ["Draft", "Purchased", "Approved", "Shipped", "Arrived", "Received"],
        "batchBranch": "Rejected or reopened → back to Draft",
        "dist": ["Submitted", "Pending", "Approved: stock moves"],
        "distBranch": "Rejected: nothing moves",
        "appr": ["Request", "Pending", "Approved: change applied"],
        "apprBranch": "Rejected: nothing changes",
        "holders": {
            "supplier": "Supplier abroad",
            "business": "Business (unassigned)",
            "shopA": "Shop A",
            "shopB": "Shop B",
            "person": "A person",
            "customer": "Customer",
            "receive": "receive",
            "distribute": "distribute",
            "sale": "sale",
        },
        "phone": [
            ("1", "Sale date", "Today, or up to 7 days back"),
            ("2", "Location", "Locked to your shop (agents)"),
            ("3", "Add a product", "Search name, SKU, length, size"),
            ("4", "Lot · quantity · price", "Suggested price filled in"),
            ("5", "Payment", "Cash · Mobile money · Credit"),
            ("6", "Record sale", "Total shown at the bottom"),
        ],
        "money": {
            "sales": "Total sales",
            "cost": "Purchase cost of the pieces sold",
            "margin": "Margin",
            "expenses": "Expenses",
            "payroll": "Payroll",
            "net": "Net profit",
            "withdrawals": "Withdrawals",
            "apart": "shown apart, never subtracted",
        },
    },
    "fr": {
        "flow": [
            ("Réquisition", "La boutique demande du stock", "Admin. en chef des ventes"),
            ("Approbation", "L'admin. en chef approuve", "Administrateur en chef"),
            ("Lot d'achat", "L'acheteur achète à l'étranger", "Admin. en chef de l'inventaire"),
            ("Marquer comme acheté", "Lignes et coûts verrouillés", "Admin. en chef de l'inventaire"),
            ("Approbation", "L'admin. en chef approuve le lot", "Administrateur en chef"),
            ("Expédié → Arrivé", "En route, puis à Goma", "Acheteur / équipe de Goma"),
            ("Réception à Goma", "Compter bons, abîmés, manquants", "Gestionnaire / Chef des ventes"),
            ("Stock de l'entreprise", "Lots vendables", ""),
            ("Distribution", "Envoyer à une boutique ou une personne", "Gestionnaire / Chef des ventes"),
            ("Approbation", "L'admin. en chef approuve", "Administrateur en chef"),
            ("Stock en boutique", "Prêt à vendre", ""),
            ("Vente", "Enregistrée sur le téléphone", "Agent commercial"),
        ],
        "flowEnd": "Analyses",
        "req": ["Brouillon", "Soumise", "Approuvée", "En cours d'achat", "Clôturée"],
        "reqBranch": "Rejetée → corriger et resoumettre",
        "batch": ["Brouillon", "Acheté", "Approuvé", "Expédié", "Arrivé", "Réceptionné"],
        "batchBranch": "Rejeté ou rouvert → retour au brouillon",
        "dist": ["Soumise", "En attente", "Approuvée : le stock bouge"],
        "distBranch": "Rejetée : rien ne bouge",
        "appr": ["Demande", "En attente", "Approuvée : changement appliqué"],
        "apprBranch": "Rejetée : rien ne change",
        "holders": {
            "supplier": "Fournisseur à l'étranger",
            "business": "Entreprise (non attribué)",
            "shopA": "Boutique A",
            "shopB": "Boutique B",
            "person": "Une personne",
            "customer": "Client",
            "receive": "réception",
            "distribute": "distribution",
            "sale": "vente",
        },
        "phone": [
            ("1", "Date de la vente", "Aujourd'hui, ou jusqu'à 7 jours avant"),
            ("2", "Site", "Imposé : votre boutique (agents)"),
            ("3", "Ajouter un produit", "Nom, SKU, longueur, taille"),
            ("4", "Lot · quantité · prix", "Prix conseillé prérempli"),
            ("5", "Paiement", "Espèces · Mobile money · Crédit"),
            ("6", "Enregistrer la vente", "Total affiché en bas"),
        ],
        "money": {
            "sales": "Ventes totales",
            "cost": "Coût d'achat des pièces vendues",
            "margin": "Marge",
            "expenses": "Dépenses",
            "payroll": "Paie",
            "net": "Bénéfice net",
            "withdrawals": "Retraits",
            "apart": "affichés à part, jamais soustraits",
        },
    },
}

# ------------------------------------------------------------- SVG kit

FONT = "font-family='Inter, Helvetica, Arial, sans-serif'"


def esc(s: str) -> str:
    return html.escape(s, quote=True)


def wrap(text: str, max_chars: int) -> list[str]:
    words, lines, line = text.split(), [], ""
    for w in words:
        if line and len(line) + 1 + len(w) > max_chars:
            lines.append(line)
            line = w
        else:
            line = f"{line} {w}".strip()
    if line:
        lines.append(line)
    return lines


def text_block(x, y, text, size, max_chars, weight="400", fill=INK, anchor="middle", gap=1.25):
    out = []
    for i, line in enumerate(wrap(text, max_chars)):
        out.append(
            f"<text x='{x}' y='{y + i * size * gap:.1f}' {FONT} font-size='{size}' "
            f"font-weight='{weight}' fill='{fill}' text-anchor='{anchor}'>{esc(line)}</text>"
        )
    return "".join(out)


def box(x, y, w, h, fill=SOFT, stroke=LINE, rx=10):
    return f"<rect x='{x}' y='{y}' width='{w}' height='{h}' rx='{rx}' fill='{fill}' stroke='{stroke}' stroke-width='1.4'/>"


ARROW_DEF = (
    "<defs><marker id='arr' viewBox='0 0 10 10' refX='9' refY='5' markerWidth='7' markerHeight='7' "
    f"orient='auto-start-reverse'><path d='M0,0 L10,5 L0,10 z' fill='{MID}'/></marker></defs>"
)


def arrow(x1, y1, x2, y2, dashed=False, color=MID):
    dash = " stroke-dasharray='5 4'" if dashed else ""
    return (
        f"<line x1='{x1}' y1='{y1}' x2='{x2}' y2='{y2}' stroke='{color}' stroke-width='1.8'{dash} "
        "marker-end='url(#arr)'/>"
    )


def svg(w, h, body):
    return (
        f"<svg viewBox='0 0 {w} {h}' xmlns='http://www.w3.org/2000/svg' role='img' class='diagram' "
        f"style='max-width:{round(w * 1.05)}px'>"
        f"{ARROW_DEF}{body}</svg>"
    )


# ------------------------------------------------------------ diagrams


def d_flow(lab):
    """The whole stock lifecycle, as a snake of 12 steps (3 per row)."""
    steps = lab["flow"]
    cols, bw, bh, gx, gy, ox, oy = 3, 210, 92, 60, 46, 20, 20
    body = []
    pos = []
    for i, _ in enumerate(steps):
        row, col = divmod(i, cols)
        if row % 2 == 1:
            col = cols - 1 - col
        pos.append((ox + col * (bw + gx), oy + row * (bh + gy)))
    for i, (title, sub, who) in enumerate(steps):
        x, y = pos[i]
        approval = title in ("Approval", "Approbation")
        stock = i in (7, 10)
        fill = ACCENT if stock else ("#fff7e8" if approval else SOFT)
        stroke = "#d9a548" if approval else LINE
        body.append(box(x, y, bw, bh, fill, stroke))
        body.append(f"<circle cx='{x + 16}' cy='{y + 16}' r='11' fill='{INK}'/>")
        body.append(
            f"<text x='{x + 16}' y='{y + 20}' {FONT} font-size='11' font-weight='700' fill='#fff' text-anchor='middle'>{i + 1}</text>"
        )
        body.append(text_block(x + bw / 2 + 8, y + 26, title, 14, 22, "700"))
        body.append(text_block(x + bw / 2, y + 50, sub, 11.5, 30, "400", "#3d4b42"))
        if who:
            body.append(text_block(x + bw / 2, y + bh - 9, who, 10, 34, "600", MID))
        if i + 1 < len(steps):
            nx, ny = pos[i + 1]
            if ny == y:
                if nx > x:
                    body.append(arrow(x + bw, y + bh / 2, nx - 2, ny + bh / 2))
                else:
                    body.append(arrow(x, y + bh / 2, nx + bw + 2, ny + bh / 2))
            else:
                body.append(arrow(x + bw / 2, y + bh, nx + bw / 2, ny - 2))
    lx, ly = pos[-1]
    ex, ey = lx + bw / 2 - 70, ly + bh + 30
    body.append(arrow(lx + bw / 2, ly + bh, lx + bw / 2, ey - 2))
    body.append(box(ex, ey, 140, 40, INK, INK))
    body.append(text_block(ex + 70, ey + 25, lab["flowEnd"], 14, 20, "700", "#fff"))
    width = ox * 2 + cols * bw + (cols - 1) * gx
    height = ey + 40 + 20
    return svg(width, height, "".join(body))


def d_status(steps, branch, final_ok=True):
    """A status chain with a side branch (rejection) under the second step."""
    n = len(steps)
    bw, bh, gx, ox, oy = 128, 52, 30, 10, 10
    width = ox * 2 + n * bw + (n - 1) * gx
    body = []
    for i, s in enumerate(steps):
        x = ox + i * (bw + gx)
        last = i == n - 1
        body.append(box(x, oy, bw, bh, ACCENT if (last and final_ok) else SOFT, LINE))
        body.append(text_block(x + bw / 2, oy + (bh / 2 + 5 if len(wrap(s, 17)) == 1 else 22), s, 12.5, 17, "700"))
        if not last:
            body.append(arrow(x + bw, oy + bh / 2, x + bw + gx - 2, oy + bh / 2))
    bx = ox + (bw + gx) * 1
    by = oy + bh + 44
    bwide = min(width - bx - 10, 330)
    body.append(arrow(bx + bw / 2, oy + bh, bx + bw / 2, by - 2, dashed=True, color=RED))
    body.append(box(bx, by, bwide, 42, RED_BG, "#f1a9a3"))
    body.append(text_block(bx + bwide / 2, by + 26, branch, 12, 48, "600", RED))
    return svg(width, by + 42 + 12, "".join(body))


def d_holders(lab):
    h = lab["holders"]
    body = []
    body.append(box(10, 95, 150, 56, "#fff", LINE))
    body.append(text_block(85, 128, h["supplier"], 12.5, 18, "600"))
    body.append(box(225, 85, 175, 76, ACCENT, LINE))
    body.append(text_block(312, 127, h["business"], 13.5, 18, "700"))
    body.append(arrow(160, 123, 223, 123))
    body.append(text_block(192, 114, h["receive"], 10.5, 20, "600", MID))
    for i, (key, y) in enumerate([("shopA", 10), ("shopB", 95), ("person", 180)]):
        body.append(box(470, y, 150, 56, SOFT, LINE))
        body.append(text_block(545, y + 33, h[key], 13, 18, "700"))
        body.append(arrow(400, 123, 468, y + 28))
        body.append(box(700, y, 120, 56, "#fff", LINE))
        body.append(text_block(760, y + 33, h["customer"], 12.5, 16, "600"))
        body.append(arrow(620, y + 28, 698, y + 28))
        body.append(text_block(659, y + 20, h["sale"], 10.5, 12, "600", MID))
    body.append(text_block(435, 72, h["distribute"], 10.5, 14, "600", MID))
    return svg(830, 250, "".join(body))


def d_phone(lab):
    body = []
    body.append(f"<rect x='20' y='8' width='250' height='470' rx='30' fill='#fff' stroke='{INK}' stroke-width='3'/>")
    body.append(f"<rect x='115' y='20' width='60' height='6' rx='3' fill='{LINE}'/>")
    y = 44
    for num, title, sub in lab["phone"]:
        last = num == "6"
        fill = INK if last else SOFT
        color = "#fff" if last else INK
        body.append(box(38, y, 214, 60, fill, LINE, 9))
        body.append(text_block(54, y + 26, num, 13, 4, "800", ACCENT if last else MID, "start"))
        body.append(text_block(74, y + 26, title, 13, 26, "700", color, "start"))
        body.append(text_block(74, y + 45, sub, 10.5, 34, "400", "#dfe8dc" if last else "#3d4b42", "start"))
        y += 70
    return svg(290, 488, "".join(body))


def d_money(lab):
    m = lab["money"]
    body = []
    rows = [
        (m["sales"], "$185.00", SOFT, INK),
        ("− " + m["cost"], "$81.77", "#fff", INK),
        ("= " + m["margin"], "$103.23", ACCENT, INK),
        ("− " + m["expenses"], "$518.60", "#fff", INK),
        ("− " + m["payroll"], "$0.00", "#fff", INK),
        ("= " + m["net"], "−$415.37", RED_BG, RED),
    ]
    y = 10
    for label, value, fill, color in rows:
        body.append(box(10, y, 470, 42, fill, LINE, 8))
        body.append(text_block(28, y + 27, label, 13.5, 60, "600", color, "start"))
        body.append(text_block(462, y + 27, value, 14, 20, "700", color, "end"))
        y += 50
    body.append(box(510, 10, 220, 92, WARN_BG, "#e9b679", 8))
    body.append(text_block(620, 44, m["withdrawals"] + ": $26.00", 14, 26, "700", WARN))
    body.append(text_block(620, 70, m["apart"], 11.5, 28, "500", WARN))
    return svg(740, y + 4, "".join(body))


DIAGRAMS = {
    "flow": lambda lab: d_flow(lab),
    "requisition": lambda lab: d_status(lab["req"], lab["reqBranch"]),
    "batch": lambda lab: d_status(lab["batch"], lab["batchBranch"]),
    "distribution": lambda lab: d_status(lab["dist"], lab["distBranch"]),
    "approval": lambda lab: d_status(lab["appr"], lab["apprBranch"]),
    "holders": lambda lab: d_holders(lab),
    "phone": lambda lab: d_phone(lab),
    "money": lambda lab: d_money(lab),
}

# ------------------------------------------------------------- assembly

TITLES = {"en": "CHIRHUZA GROUP Ltd — Training guide", "fr": "CHIRHUZA GROUP Ltd — Guide de formation"}


def build(lang: str) -> pathlib.Path:
    lab = L[lang]
    content = (HERE / f"content-{lang}.html").read_text(encoding="utf-8")

    def place(match: re.Match) -> str:
        name = match.group(1)
        if name not in DIAGRAMS:
            sys.exit(f"Unknown diagram: {name}")
        return f"<figure class='figure'>{DIAGRAMS[name](lab)}</figure>"

    content = re.sub(r"\{\{diagram:([a-z]+)\}\}", place, content)
    css = (HERE / "style.css").read_text(encoding="utf-8")
    page = (
        f"<!doctype html><html lang='{lang}'><head><meta charset='utf-8'>"
        f"<title>{esc(TITLES[lang])} {VERSION}</title><style>{css}</style></head>"
        f"<body>{content}</body></html>"
    )
    out = HERE / f"guide-{lang}.html"
    out.write_text(page, encoding="utf-8")
    return out


def render(html_path: pathlib.Path, lang: str) -> pathlib.Path:
    pdf = HERE / f"chirhuza-training-guide-{VERSION}-{lang}.pdf"
    subprocess.run(
        [
            CHROME,
            "--headless",
            "--disable-gpu",
            "--no-pdf-header-footer",
            f"--print-to-pdf={pdf}",
            html_path.as_uri(),
        ],
        check=True,
        capture_output=True,
    )
    return pdf


if __name__ == "__main__":
    for lang in ("en", "fr"):
        html_path = build(lang)
        print("built", html_path.name, "->", render(html_path, lang).name)

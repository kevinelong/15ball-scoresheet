"""
K-Ball Paper Score-Sheet - blank printable (matches the annotated guide)

Uses the SAME draw_scoresheet() function as build_paper_guide.py so the
blank printable and its annotated tutorial can never drift.

Layout: ONE full-page blank score sheet per letter page. Uses the whole
vertical budget so ball circles are large enough to hand-mark comfortably.
An earlier 2-up version stacked two sheets per page with a cut line; that
was retired because the resulting ball circles were too small to mark
inside cleanly and the bottom-totals labels had to wrap onto two lines.

Run:    python3 docs/build_paper_sheet.py
Output: docs/paper-score-sheet-blank.pdf
"""
from __future__ import annotations
import os
import sys

HERE = os.path.dirname(__file__)
sys.path.insert(0, HERE)

from reportlab.pdfgen import canvas  # noqa: E402
from reportlab.lib.pagesizes import letter  # noqa: E402

# Reuse the guide's drawing primitives so the blank matches the annotated
# version pixel-for-pixel.
from build_paper_guide import (  # noqa: E402
    draw_scoresheet,
    BLACK,
    FONT_BODY,
    MARGIN,
    PAGE_W,
    PAGE_H,
)

OUT = os.path.join(HERE, "paper-score-sheet-blank.pdf")


def build(out_path):
    c = canvas.Canvas(out_path, pagesize=letter)
    c.setAuthor("Perplexity Computer")
    c.setTitle("K-Ball Blank Paper Score Sheet")
    c.setSubject(
        "Blank printable K-Ball / 15-Ball Rotation score sheet. One sheet "
        "per letter page; larger ball circles for hand marking."
    )
    c.setCreator("kball-scoresheet docs/build_paper_sheet.py")

    # Full-page single sheet. Reserve a strip at the bottom for the footer
    # so the sheet's outer border never crashes into the footer text.
    footer_h = 14
    sheet_top = PAGE_H - MARGIN
    sheet_w = PAGE_W - 2 * MARGIN
    sheet_h = (PAGE_H - 2 * MARGIN) - footer_h

    draw_scoresheet(c, MARGIN, sheet_top, sheet_w, sheet_h)

    # --- Footer with source link ---
    c.setFont(FONT_BODY, 6.5)
    c.setFillColorRGB(*BLACK)
    c.drawString(
        MARGIN,
        MARGIN - 8,
        "ColumbiaCueClub.com  -  K-Ball / 15-Ball Rotation blank score sheet",
    )
    c.drawRightString(PAGE_W - MARGIN, MARGIN - 8, "Blank Sheet v2")

    c.showPage()
    c.save()
    print(f"Wrote {out_path}")


def main():
    build(OUT)


if __name__ == "__main__":
    main()

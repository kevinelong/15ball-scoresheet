"""
K-Ball Paper Score-Sheet - blank printable (matches the annotated guide)

Uses the SAME draw_scoresheet() function as build_paper_guide.py so the
blank printable and its annotated tutorial can never drift.

Layout: two blank sheets stacked on one letter page (top + bottom, with
a cut line down the middle). Print a stack, slice in half with a paper
cutter, and you have twice as many blanks per sheet of paper.

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
from reportlab.lib.units import inch  # noqa: E402

# Reuse the guide's drawing primitives so the blank matches the annotated
# version pixel-for-pixel.
from build_paper_guide import (  # noqa: E402
    draw_scoresheet,
    BLACK,
    LINE_STRONG,
    FONT_BODY,
    FONT_BOLD,
    MARGIN,
    PAGE_W,
    PAGE_H,
)

OUT = os.path.join(HERE, "paper-score-sheet-blank.pdf")


def draw_cut_line(c, y):
    """Dashed horizontal cut line with scissor hint."""
    c.setStrokeColorRGB(*BLACK)
    c.setLineWidth(0.4)
    c.setDash(3, 3)
    c.line(MARGIN, y, PAGE_W - MARGIN, y)
    c.setDash()  # reset
    # small scissor-icon substitute: a black arrowhead + "cut here" text
    c.setFont(FONT_BODY, 6.5)
    label = " cut here "
    label_w = c.stringWidth(label, FONT_BODY, 6.5)
    lx = (PAGE_W - label_w) / 2
    # blank behind the label so the dashed line doesn't cross the text
    c.setFillColorRGB(1, 1, 1)
    c.rect(lx - 1, y - 4, label_w + 2, 9, stroke=0, fill=1)
    c.setFillColorRGB(*BLACK)
    c.drawString(lx, y - 2.5, label)


def build(out_path):
    c = canvas.Canvas(out_path, pagesize=letter)
    c.setAuthor("Perplexity Computer")
    c.setTitle("K-Ball Blank Paper Score Sheet (2-up)")
    c.setSubject(
        "Blank printable K-Ball / 15-Ball Rotation score sheet. Two sheets per "
        "letter page; cut on the dashed line."
    )
    c.setCreator("kball-scoresheet docs/build_paper_sheet.py")

    # Available printable height: PAGE_H - 2*MARGIN.
    # We stack 2 sheets vertically with a small gap for the cut line.
    usable_h = PAGE_H - 2 * MARGIN
    gap = 18  # points between the two half-pages
    sheet_h = (usable_h - gap) / 2
    sheet_w = PAGE_W - 2 * MARGIN

    # --- Top sheet ---
    top_top = PAGE_H - MARGIN
    draw_scoresheet(c, MARGIN, top_top, sheet_w, sheet_h)

    # --- Cut line ---
    cut_y = top_top - sheet_h - gap / 2
    draw_cut_line(c, cut_y)

    # --- Bottom sheet ---
    bottom_top = cut_y - gap / 2
    draw_scoresheet(c, MARGIN, bottom_top, sheet_w, sheet_h)

    # --- Tiny footer with source link ---
    c.setFont(FONT_BODY, 6.5)
    c.setFillColorRGB(*BLACK)
    c.drawString(MARGIN, MARGIN - 8, "ColumbiaCueClub.com  -  K-Ball / 15-Ball Rotation blank score sheet")
    c.drawRightString(PAGE_W - MARGIN, MARGIN - 8, "Blank Sheet v1")

    c.showPage()
    c.save()
    print(f"Wrote {out_path}")


def main():
    build(OUT)


if __name__ == "__main__":
    main()

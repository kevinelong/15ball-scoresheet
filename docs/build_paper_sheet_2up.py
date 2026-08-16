"""
K-Ball Paper Score-Sheet - 2-up landscape variant

Prints TWO complete blank score sheets side-by-side on a single letter
page in LANDSCAPE orientation. Cuts paper consumption in half at the
scorekeeper desk when a tournament is generating many matches.

Each half-page sheet is 5.5" wide x 8.5" tall - a taller/narrower aspect
than the 1-up version, but with all the same self-teaching content
(HOW TO SCORE strip, K-BALL RULES SUMMARY block, and WPA QR code).

Run:    python3 docs/build_paper_sheet_2up.py
Output: docs/paper-score-sheet-2up.pdf
"""
from __future__ import annotations
import os
import sys

HERE = os.path.dirname(__file__)
sys.path.insert(0, HERE)

from reportlab.pdfgen import canvas  # noqa: E402
from reportlab.lib.pagesizes import letter, landscape  # noqa: E402

from _scoresheet_draw import (  # noqa: E402
    draw_scoresheet,
    BLACK,
    FONT_BODY,
    MARGIN,
)

OUT = os.path.join(HERE, "paper-score-sheet-2up.pdf")


def build(out_path):
    PAGE_W, PAGE_H = landscape(letter)  # 11" x 8.5"
    c = canvas.Canvas(out_path, pagesize=landscape(letter))
    c.setAuthor("Perplexity Computer")
    c.setTitle("K-Ball Blank Paper Score Sheet (2-up)")
    c.setSubject(
        "Two blank K-Ball score sheets side-by-side on landscape letter. "
        "Fold or cut along the middle to hand out to two matches at once."
    )
    c.setCreator("kball-scoresheet docs/build_paper_sheet_2up.py")

    # Layout: 2 columns, small gutter between, matching outer margins.
    footer_h = 12
    gutter = 12
    inner_w = PAGE_W - 2 * MARGIN
    sheet_w = (inner_w - gutter) / 2
    sheet_top = PAGE_H - MARGIN
    sheet_h = (PAGE_H - 2 * MARGIN) - footer_h

    left_x = MARGIN
    right_x = MARGIN + sheet_w + gutter

    # Draw both sheets. Both are fully self-teaching (with_instructions=True).
    draw_scoresheet(c, left_x, sheet_top, sheet_w, sheet_h)
    draw_scoresheet(c, right_x, sheet_top, sheet_w, sheet_h)

    # --- Dashed cut line down the middle ---
    c.setStrokeColorRGB(*BLACK)
    c.setDash(2, 3)
    c.setLineWidth(0.4)
    mid_x = left_x + sheet_w + gutter / 2
    c.line(mid_x, MARGIN, mid_x, sheet_top)
    c.setDash()  # reset

    # Tiny scissor icon caption near top of cut line.
    c.setFont(FONT_BODY, 6.5)
    c.setFillColorRGB(*BLACK)
    c.drawCentredString(mid_x, sheet_top + 3, "cut / fold")

    # --- Footer ---
    c.setFont(FONT_BODY, 6.5)
    c.drawString(
        MARGIN,
        MARGIN - 8,
        "ColumbiaCueClub.com  -  K-Ball / 15-Ball Rotation blank score sheet (2-up landscape)",
    )
    c.drawRightString(PAGE_W - MARGIN, MARGIN - 8, "Blank Sheet 2-up v1")

    c.showPage()
    c.save()
    print(f"Wrote {out_path}")


def main():
    build(OUT)


if __name__ == "__main__":
    main()

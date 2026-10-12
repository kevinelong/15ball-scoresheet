"""
14.1 Straight Pool Paper Score-Sheet - blank printable

Built exactly like the 15-Ball sheet (build_15ball_paper_sheet.py); everything that
differs by discipline lives in _scoresheet_141_draw.py, so this file only does the
page, the footer and the PDF metadata.

ONE full-page blank sheet per letter page: eight racks of 14 balls, which is what a match
to 100 needs. Straight pool is normally one sheet per match, so there is no 2-up companion:
on a half page (354pt wide) each player gets 158pt, the stats strip takes 116pt of it, and
fourteen balls then share 42pt - 5.8pt circles, against 18.6pt here, and the layout needs
532pt of height against the half page's 528. Eight racks cannot be marked at that size.

Run:    python3 docs/build_141_paper_sheet.py
Output: docs/141-paper-sheet.pdf
        (its QR points at docs/141-rules.pdf, built by docs/build_141_rules.py)
"""
from __future__ import annotations
import os
import sys

HERE = os.path.dirname(__file__)
sys.path.insert(0, HERE)

from reportlab.pdfgen import canvas  # noqa: E402
from reportlab.lib.pagesizes import letter  # noqa: E402

# Shared drawing primitives so the 14.1 sheet has the same construction as the 15-Ball one.
from _scoresheet_141_draw import (  # noqa: E402
    draw_scoresheet,
    BLACK,
    FONT_BODY,
    MARGIN,
    PAGE_W,
    PAGE_H,
)

OUT = os.path.join(HERE, "141-paper-sheet.pdf")


def build(out_path):
    c = canvas.Canvas(out_path, pagesize=letter)
    c.setAuthor("Perplexity Computer")
    c.setTitle("14.1 Straight Pool Blank Paper Score Sheet")
    c.setSubject(
        "Blank printable 14.1 Straight Pool score sheet. One sheet per letter page; "
        "eight racks of 14 balls, continuous running total to a goal of 75 or 100."
    )
    c.setCreator("15ball-scoresheet docs/build_141_paper_sheet.py")

    # Full-page single sheet. Reserve a strip at the bottom for the footer so the sheet's
    # outer border never crashes into the footer text.
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
        "ColumbiaCueClub.com  -  14.1 Straight Pool blank score sheet",
    )
    c.drawRightString(PAGE_W - MARGIN, MARGIN - 8, "Blank Sheet v1")

    c.showPage()
    c.save()
    print(f"Wrote {out_path}")


def main():
    build(OUT)


if __name__ == "__main__":
    main()

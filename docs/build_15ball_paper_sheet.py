"""
15-Ball Rotation Paper Score-Sheet - blank printable

Uses the shared draw_scoresheet() from _scoresheet_draw.py so this
printable and any other paper variant stay in lockstep.

Layout: ONE full-page blank score sheet per letter page. Uses the whole
vertical budget so ball circles are large enough to hand-mark comfortably.

Run:    python3 docs/build_15ball_paper_sheet.py
Output: docs/15ball-paper-sheet.pdf
"""
from __future__ import annotations
import os
import sys

HERE = os.path.dirname(__file__)
sys.path.insert(0, HERE)

from reportlab.pdfgen import canvas  # noqa: E402
from reportlab.lib.pagesizes import letter  # noqa: E402

# Shared drawing primitives so every paper variant renders identically.
from _scoresheet_draw import (  # noqa: E402
    draw_scoresheet,
    BLACK,
    FONT_BODY,
    MARGIN,
    PAGE_W,
    PAGE_H,
)

OUT = os.path.join(HERE, "15ball-paper-sheet.pdf")


def build(out_path):
    c = canvas.Canvas(out_path, pagesize=letter)
    c.setAuthor("Perplexity Computer")
    c.setTitle("15-Ball Rotation Blank Paper Score Sheet")
    c.setSubject(
        "Blank printable 15-Ball Rotation score sheet. One sheet per "
        "letter page; larger ball circles for hand marking."
    )
    c.setCreator("15ball-scoresheet docs/build_15ball_paper_sheet.py")

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
        "ColumbiaCueClub.com  -  15-Ball Rotation blank score sheet",
    )
    c.drawRightString(PAGE_W - MARGIN, MARGIN - 8, "Blank Sheet v2")

    c.showPage()
    c.save()
    print(f"Wrote {out_path}")


def main():
    build(OUT)


if __name__ == "__main__":
    main()

"""
14.1 Straight Pool - club rules PDF

The full rules for the discipline the 14.1 sheet is for, written out plainly for
Columbia Cue Club and laid out in the style of build_15ball_rules.py (same cover
furniture, same source chips, same page header/footer, QR to the WPA rulebook).

Substance is the WPA's 14.1 Continuous rules, which are the world standard; nothing
here changes them. Where a rule number is quoted it is the WPA's own section number
(Rule 4 in the WPA Rules of Play), so the document can be read alongside that book.

Run:    python3 docs/build_141_rules.py
Output: docs/141-rules.pdf
"""
from __future__ import annotations
import os
import sys

HERE = os.path.dirname(__file__)
sys.path.insert(0, HERE)

from reportlab.pdfgen import canvas  # noqa: E402
from reportlab.lib.pagesizes import letter  # noqa: E402
from reportlab.lib.units import inch  # noqa: E402
from reportlab.pdfbase.pdfmetrics import stringWidth  # noqa: E402

# The sheet's own shared module provides the QR drawer, exactly as the 15-Ball
# rules document reuses it from _scoresheet_draw.py.
from _scoresheet_141_draw import draw_qr  # noqa: E402

OUT = os.path.join(HERE, "141-rules.pdf")

PAGE_W, PAGE_H = letter
MARGIN = 0.6 * inch
BLACK = (0, 0, 0)
GRAY = (0.35, 0.35, 0.35)
LIGHT_GRAY = (0.75, 0.75, 0.75)
CHIP_BG_CLUB = (0.90, 0.90, 0.90)    # emphasized chip (club practice)
CHIP_BG_WPA = (0.98, 0.98, 0.98)     # muted chip (straight from the WPA book)

FONT_BODY = "Helvetica"
FONT_BOLD = "Helvetica-Bold"
FONT_ITALIC = "Helvetica-Oblique"
FONT_BOLD_ITALIC = "Helvetica-BoldOblique"

# The same rulebook the 15-Ball rules document cites, so both point at one edition.
WPA_RULES_LANDING = "https://wpapool.com/rules/"
WPA_RULES_PDF = "https://wpapool.com/wp-content/uploads/2026/01/2026.01.02-WPA-Rules.pdf"

H1_SIZE = 17
H2_SIZE = 12
H3_SIZE = 10.5
BODY_SIZE = 9.5
LEADING = 12
PARA_GAP = 5

# Chip taxonomy: (label, background, font for the RULE heading, note)
CHIP = {
    "WPA":  ("WPA", CHIP_BG_WPA, FONT_BODY, "Straight from the WPA 14.1 rules"),
    "Club": ("Club", CHIP_BG_CLUB, FONT_BOLD_ITALIC, "How we run it at the club"),
}


class Cursor:
    """Position on the page, with the page header/footer the 15-Ball document uses."""

    def __init__(self, c: canvas.Canvas, margin: float = MARGIN):
        self.c = c
        self.margin = margin
        self.x = margin
        self.y = PAGE_H - margin
        self.col_w = PAGE_W - 2 * margin
        self.page = 1

    def advance(self, dy: float) -> None:
        self.y -= dy
        if self.y < self.margin + 40:
            self.page_break()

    def need(self, h: float) -> None:
        if self.y - h < self.margin + 40:
            self.page_break()

    def page_break(self) -> None:
        self._draw_footer()
        self.c.showPage()
        self.page += 1
        self.y = PAGE_H - self.margin
        self._draw_page_header()

    def _draw_page_header(self) -> None:
        c = self.c
        c.setFont(FONT_BODY, 7.5)
        c.setFillColorRGB(*GRAY)
        c.drawString(self.margin, PAGE_H - self.margin + 6,
                     "14.1 STRAIGHT POOL - STANDARD RULES")
        c.drawRightString(PAGE_W - self.margin, PAGE_H - self.margin + 6,
                          "Columbia Cue Club")
        c.setStrokeColorRGB(*LIGHT_GRAY)
        c.setLineWidth(0.4)
        c.line(self.margin, PAGE_H - self.margin, PAGE_W - self.margin, PAGE_H - self.margin)
        c.setFillColorRGB(*BLACK)
        self.y = PAGE_H - self.margin - 8

    def _draw_footer(self) -> None:
        c = self.c
        c.setFont(FONT_BODY, 7.5)
        c.setFillColorRGB(*GRAY)
        c.drawString(self.margin, self.margin - 14,
                     "The WPA Rules of Play is the last word  -  wpapool.com/rules/")
        c.drawRightString(PAGE_W - self.margin, self.margin - 14, f"Page {self.page}")
        c.setFillColorRGB(*BLACK)


def wrap_lines(text: str, font: str, size: float, max_w: float) -> list[str]:
    words = text.split()
    if not words:
        return [""]
    lines, cur = [], ""
    for w in words:
        cand = cur + (" " if cur else "") + w
        if stringWidth(cand, font, size) <= max_w:
            cur = cand
        else:
            if cur:
                lines.append(cur)
            cur = w
    if cur:
        lines.append(cur)
    return lines


def draw_para(cur: Cursor, text: str, *, font=FONT_BODY, size=BODY_SIZE,
              leading=LEADING, indent=0.0, gap_after=PARA_GAP) -> None:
    c = cur.c
    lines = wrap_lines(text, font, size, cur.col_w - indent)
    cur.need(leading * len(lines) + gap_after)
    c.setFont(font, size)
    c.setFillColorRGB(*BLACK)
    for ln in lines:
        c.drawString(cur.x + indent, cur.y - size, ln)
        cur.advance(leading)
    cur.advance(gap_after)


def draw_bulleted(cur: Cursor, items: list[str], *, indent=16.0, bullet="-") -> None:
    c = cur.c
    for item in items:
        lines = wrap_lines(item, FONT_BODY, BODY_SIZE, cur.col_w - indent)
        cur.need(LEADING * len(lines) + 2)
        c.setFont(FONT_BODY, BODY_SIZE)
        c.setFillColorRGB(*BLACK)
        c.drawString(cur.x + indent - 10, cur.y - BODY_SIZE, bullet)
        for ln in lines:
            c.drawString(cur.x + indent, cur.y - BODY_SIZE, ln)
            cur.advance(LEADING)
        cur.advance(1)
    cur.advance(3)


def draw_h1(cur: Cursor, text: str) -> None:
    cur.need(H1_SIZE + 18)
    c = cur.c
    c.setFont(FONT_BOLD, H1_SIZE)
    c.setFillColorRGB(*BLACK)
    c.drawString(cur.x, cur.y - H1_SIZE, text)
    cur.advance(H1_SIZE + 4)
    c.setStrokeColorRGB(*BLACK)
    c.setLineWidth(0.8)
    c.line(cur.x, cur.y, cur.x + cur.col_w, cur.y)
    cur.advance(12)


def draw_chip(c: canvas.Canvas, x: float, y: float, source: str) -> float:
    """Draw a source chip and return its width."""
    label, bg, _font, _note = CHIP[source]
    text = f"[{label}]"
    size = 7.0
    tw = stringWidth(text, FONT_BOLD, size)
    w = tw + 8
    h = size + 4
    c.setFillColorRGB(*bg)
    c.setStrokeColorRGB(*LIGHT_GRAY)
    c.setLineWidth(0.4)
    c.roundRect(x, y - h + 2, w, h, 2, stroke=1, fill=1)
    c.setFillColorRGB(*BLACK)
    c.setFont(FONT_BOLD, size)
    c.drawString(x + 4, y - size + 2, text)
    return w


def draw_rule(cur: Cursor, num: str, title: str, source: str, body: str,
              bullets: list[str] | None = None) -> None:
    """A numbered rule: WPA section number, heading, source chip, then plain English."""
    cur.need(H3_SIZE + 26)
    c = cur.c
    rule_font = CHIP[source][2]
    c.setFont(rule_font, H3_SIZE)
    c.setFillColorRGB(*BLACK)
    label = f"{num}  {title}"
    c.drawString(cur.x, cur.y - H3_SIZE, label)
    draw_chip(c, cur.x + stringWidth(label, rule_font, H3_SIZE) + 8, cur.y - 1, source)
    cur.advance(H3_SIZE + 6)
    draw_para(cur, body, indent=10, gap_after=3)
    if bullets:
        draw_bulleted(cur, bullets, indent=22)
        cur.advance(2)


# ---------- Cover page ----------

def draw_cover(c: canvas.Canvas) -> None:
    c.setFillColorRGB(*BLACK)
    c.setFont(FONT_BOLD, 32)
    c.drawString(MARGIN, PAGE_H - MARGIN - 40, "14.1 STRAIGHT POOL")
    c.setFont(FONT_BODY, 16)
    c.drawString(MARGIN, PAGE_H - MARGIN - 64, "Straight Pool - Standard Rules")

    c.setFont(FONT_ITALIC, 10.5)
    c.setFillColorRGB(*GRAY)
    c.drawString(MARGIN, PAGE_H - MARGIN - 84,
                 "The WPA game written out plainly for Columbia Cue Club, with our score sheet behind it.")
    c.setFillColorRGB(*BLACK)

    box_x = MARGIN
    box_y_top = PAGE_H - MARGIN - 130
    box_h = 214
    box_w = PAGE_W - 2 * MARGIN
    c.setStrokeColorRGB(*BLACK)
    c.setLineWidth(1.2)
    c.rect(box_x, box_y_top - box_h, box_w, box_h, stroke=1, fill=0)

    inner_pad = 20
    y = box_y_top - inner_pad - 4
    c.setFont(FONT_BOLD, 13)
    c.setFillColorRGB(*BLACK)
    c.drawString(box_x + inner_pad, y, "ABOUT 14.1 CONTINUOUS")
    y -= 20

    c.setFont(FONT_BODY, 10.5)
    for line in wrap_lines(
        "Straight pool is the game the others borrowed from. Fifteen balls, and every ball "
        "pocketed on a called shot is one point. Nothing resets between racks: once fourteen "
        "balls are down the fifteenth stays on the table as the break ball and the rest are "
        "re-racked, so a run carries straight on into the next rack. Fouls cost a point, which "
        "is why a score can go negative. The first player to the target wins - 75 or 100 at the "
        "club, 125 or 150 if the match is a long one.",
        FONT_BODY, 10.5, box_w - 2 * inner_pad):
        c.drawString(box_x + inner_pad, y, line)
        y -= 14
    y -= 10

    c.setFont(FONT_BOLD, 13)
    c.drawString(box_x + inner_pad, y, "NOTHING HERE CHANGES THE GAME")
    y -= 20
    c.setFont(FONT_BODY, 10.5)
    for line in wrap_lines(
        "This document is the WPA's 14.1 Continuous rules, written out in plain English so a "
        "new player can read them at the table. The WPA Rules of Play is the authority: if this "
        "page and that book ever disagree, the book wins. Rule numbers below are the WPA's own, "
        "so the two can be read side by side.",
        FONT_BODY, 10.5, box_w - 2 * inner_pad):
        c.drawString(box_x + inner_pad, y, line)
        y -= 14

    # Sourcing legend
    legend_y = box_y_top - box_h - 30
    c.setFont(FONT_BOLD, 10)
    c.setFillColorRGB(*BLACK)
    c.drawString(MARGIN, legend_y, "HOW TO READ THIS DOCUMENT")
    legend_y -= 16
    c.setFont(FONT_BODY, 9)
    c.drawString(MARGIN, legend_y, "Every rule heading carries a source chip. Look for these:")
    legend_y -= 18
    for src, note in (("WPA", "The WPA rule, written out plainly. No club change."),
                      ("Club", "Club practice: the bits our score sheet and targets add.")):
        chip_w = draw_chip(c, MARGIN, legend_y + 8, src)
        c.setFont(FONT_BODY, 8)
        c.setFillColorRGB(*BLACK)
        c.drawString(MARGIN + chip_w + 6, legend_y + 1, note)
        legend_y -= 16

    # QR to the rulebook itself
    qr_size = 84
    qr_x = PAGE_W - MARGIN - qr_size
    qr_y = MARGIN + 30
    draw_qr(c, qr_x, qr_y, qr_size, WPA_RULES_PDF)
    c.setFont(FONT_BOLD, 8.5)
    c.setFillColorRGB(*BLACK)
    c.drawRightString(PAGE_W - MARGIN, qr_y - 10, "Scan: WPA Rules of Play (14.1 Continuous)")
    c.setFont(FONT_BODY, 8)
    c.setFillColorRGB(*GRAY)
    c.drawRightString(PAGE_W - MARGIN, qr_y - 22, "wpapool.com/rules/")
    c.setFillColorRGB(*BLACK)

    # Version block
    c.setFont(FONT_BOLD, 9)
    c.drawString(MARGIN, MARGIN + 60, "VERSION")
    c.setFont(FONT_BODY, 9)
    c.drawString(MARGIN, MARGIN + 46, "14.1 Straight Pool Rules v1.0")
    c.setFont(FONT_BOLD, 9)
    c.drawString(MARGIN, MARGIN + 28, "EFFECTIVE")
    c.setFont(FONT_BODY, 9)
    c.drawString(MARGIN, MARGIN + 14, "October 2026")
    c.setFont(FONT_BODY, 7.5)
    c.setFillColorRGB(*GRAY)
    c.drawString(MARGIN, MARGIN - 4,
                 "Aligned to the WPA Rules of Play, effective 2026-01-02.")
    c.setFillColorRGB(*BLACK)
    c.showPage()


# ---------- Body ----------

def draw_body(c: canvas.Canvas) -> None:
    cur = Cursor(c)
    cur._draw_page_header()

    draw_h1(cur, "THE RULES")
    draw_para(cur,
        "These are the rules of 14.1 Continuous, in the order the WPA sets them out. "
        "Everything the WPA says about general play - lagging for the break, calling a "
        "shot, cue ball in hand, spotting balls, a stalemate - applies here as it does in "
        "every other discipline, so it is summarised rather than repeated.")

    draw_rule(cur, "4.1", "LAGGING FOR THE BREAK", "WPA",
        "Players lag to decide who breaks. Nothing special about it here - the same lag as "
        "any other game.")

    draw_rule(cur, "4.2", "THE RACK", "WPA",
        "Fifteen balls in a triangle with the apex ball on the foot spot. When fourteen balls "
        "are re-racked mid-game, the apex ball is left out, so the triangle holds fourteen. "
        "The shape left on the cloth is what decides whether a ball is in the rack area.")

    draw_rule(cur, "4.3", "THE OPENING BREAK", "WPA",
        "The cue ball starts in hand behind the head string. If you do not pocket a called "
        "ball, the cue ball and two object balls must each reach a rail - miss that and it is "
        "a breaking foul, which costs two points. The incoming player then takes the table as "
        "it lies, or can ask you to break again until you satisfy it.",
        ["A break that satisfies this and pockets nothing is just an inning change. You do not "
         "score for a ball that drops uncalled on the break."])

    draw_rule(cur, "4.4", "STAYING AT THE TABLE, AND WINNING", "WPA",
        "Keep pocketing called balls and you keep shooting. When fourteen balls of a rack have "
        "gone down, play stops until the balls are re-racked, and then you carry on - the run "
        "does not end at a rack boundary. The match ends when someone reaches the target score.",
        ["That is the whole game: runs cross racks, and the only thing that ends an inning is "
         "a miss, a foul, or a called safety."])

    draw_rule(cur, "4.5", "CALLING SHOTS AND SAFETIES", "WPA",
        "Call the ball and the pocket on every shot. You can also call a safety: play then "
        "passes to your opponent at the end of the shot, and anything you pocketed on it is "
        "spotted rather than scored.")

    draw_rule(cur, "4.6", "SPOTTING BALLS", "WPA",
        "Balls pocketed on a foul, on a safety, or without a called ball having been pocketed "
        "get spotted, as does any ball driven off the table. If the fifteenth ball of a rack "
        "needs spotting while the other fourteen are untouched, it goes on the apex spot.")

    draw_rule(cur, "4.7", "SCORING", "WPA",
        "One point for every ball pocketed on a called shot. If another ball drops on the same "
        "shot, that counts too - one point each. Fouls come straight off your score, so a score "
        "of minus one or minus two is normal enough.",
        ["The sheet adds the columns up for you: balls made, minus fouls, is the rack total, and "
         "the rack total adds to the running total."])

    draw_rule(cur, "4.8", "WHEN BALLS ARE IN THE WAY OF THE RACK", "WPA",
        "Sometimes the cue ball or the fifteenth ball is sitting in the rack area and cannot "
        "stay there. Then:",
        ["Both interfering - all fifteen balls are re-racked and the cue ball is in hand behind "
         "the head string.",
         "Fifteenth ball only - it goes on the head spot, or the centre spot if the cue ball is "
         "in the way.",
         "Cue ball only - it is in hand behind the head string if the fifteenth ball is on or in "
         "front of it, otherwise it goes on the head spot (or the centre spot if that is blocked).",
         "Whichever it is, the shooter may play any ball first in the new rack."])

    draw_rule(cur, "4.9", "STANDARD FOULS", "WPA",
        "A standard foul costs one point, balls are spotted as needed, and the inning passes. "
        "The cue ball stays where it finished - with one exception, a scratch, where the "
        "incoming player gets the cue ball in hand behind the head string. The usual list:",
        ["Cue ball in a pocket or off the table.",
         "No rail after contact - nothing reaches a cushion after the cue ball touches a ball.",
         "A ball driven off the table.",
         "Touching a ball by hand, cue, chalk or clothing.",
         "Double hit, or pushing through a frozen ball.",
         "Playing out of turn, or shooting while balls are still moving.",
         "Placing the cue ball badly, or playing a ball from behind the head string when it is "
         "not allowed.",
         "Slow play, at the referee's discretion."])

    draw_rule(cur, "4.10", "BREAKING FOULS", "WPA",
        "A breaking foul costs two points instead of one, and the opponent can make you break "
        "again. If a shot is both a breaking foul and a standard foul, it is counted as a "
        "breaking foul - two points, not three.")

    draw_rule(cur, "4.11", "THREE FOULS IN A ROW", "WPA",
        "Three consecutive standard fouls cost fifteen more points on top of the usual ones, "
        "the balls are re-racked, and the offender has to break again under the opening-break "
        "rule. A breaking foul does not count towards the three. Unsportsmanlike conduct is "
        "whatever the referee decides it is worth.")

    draw_rule(cur, "4.12", "STALEMATE", "WPA",
        "If the game gets stuck and neither player is making progress, the players lag again "
        "for the break.")

    draw_h1(cur, "THE SHEET, AND HOW WE RUN IT")
    draw_rule(cur, "Club 1", "TARGETS", "Club",
        "We score to 75 or 100. The sheet has a box for each, plus a line for anything else - "
        "125 or 150 happens in longer matches, and a target that size wants a second sheet, "
        "because eight racks is what fits on one.",
        ["Each side carries its own target in the app, so uneven targets are a handicap rather "
         "than a mistake."])
    draw_rule(cur, "Club 2", "FILLING IN THE RACKS", "Club",
        "One circle per ball, marked as it drops, fourteen to a rack - the fifteenth ball is "
        "the break ball and stays on the table, so there is no circle for it. A rack that has "
        "gone right shows fourteen marks and no repeats.",
        ["Rack total = marks minus fouls. Running total = the rack total plus the rack before it.",
         "Both players sign the winner's sheet. Marking your opponent's balls as well is "
         "courtesy, not a rule."])
    draw_rule(cur, "Club 3", "THE APP", "Club",
        "The same match can be scored on a phone: open the club's scoring link and the two "
        "players load into the app. Score in points rather than racks, set the target on the "
        "race line (it reads 'Points to 100' for this game), and submit the result when the "
        "match is over. The paper sheet and the app use the same numbers.")

    cur._draw_footer()


def build(out_path: str) -> None:
    c = canvas.Canvas(out_path, pagesize=letter)
    c.setAuthor("Perplexity Computer")
    c.setTitle("14.1 Straight Pool - Standard Rules")
    c.setSubject(
        "The WPA 14.1 Continuous rules in plain English for Columbia Cue Club, with club "
        "targets, the score sheet and the app."
    )
    c.setCreator("15ball-scoresheet docs/build_141_rules.py")
    draw_cover(c)
    draw_body(c)
    c.save()
    print(f"Wrote {out_path}")


def main() -> None:
    build(OUT)


if __name__ == "__main__":
    main()

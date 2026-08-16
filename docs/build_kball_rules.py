"""
K-Ball Standard Rules - printable rulebook PDF (WPA-style)

Structure follows what best serves a human reader who wants to know
"what's actually different in K-Ball?":

  Section 1  — General (WPA general rules apply)
  Section 2  — What's New in K-Ball (summary of [K] rules)
  Section K  — The K-Ball Discipline
                 K.1..K.n rules ordered by prominence:
                   [K]        = K-Ball specific        (BOLD ITALIC)
                   [K/10]     = Adapted from 10-Ball   (BOLD)
                   [K/14.1]   = Adapted from 14.1      (BOLD)
                   [10]       = Unchanged from 10-Ball (regular)
                   [14.1]     = Unchanged from 14.1    (regular)
                   [Gen]      = From WPA general/fouls (regular)
  Appendix A — Comparison with 10-Ball and 14.1
  Appendix B — Worked scoring examples
  Appendix C — WPA cross-reference index

Sourcing chips appear beside every rule heading. The reader can scan
for [K] and see the K-Ball-specific rules at a glance.

WPA copyrighted text is NOT reproduced here. Where a K-Ball rule is
identical to a WPA rule, we cite the WPA section number and point the
reader to the WPA Rules of Play PDF (QR + URL on the cover).

Run:    python3 docs/build_kball_rules.py
Output: docs/kball-rules.pdf
"""
from __future__ import annotations
import os
import sys
from reportlab.pdfgen import canvas
from reportlab.lib.pagesizes import letter
from reportlab.lib.units import inch
from reportlab.pdfbase.pdfmetrics import stringWidth

HERE = os.path.dirname(__file__)
sys.path.insert(0, HERE)

from _scoresheet_draw import draw_qr  # noqa: E402

OUT = os.path.join(HERE, "kball-rules.pdf")

PAGE_W, PAGE_H = letter
MARGIN = 0.6 * inch
BLACK = (0, 0, 0)
GRAY = (0.35, 0.35, 0.35)
LIGHT_GRAY = (0.75, 0.75, 0.75)
CHIP_BG_K = (0.90, 0.90, 0.90)       # emphasized chip (K-Ball specific)
CHIP_BG_ADAPT = (0.95, 0.95, 0.95)   # secondary chip
CHIP_BG_WPA = (0.98, 0.98, 0.98)     # muted chip

FONT_BODY = "Helvetica"
FONT_BOLD = "Helvetica-Bold"
FONT_ITALIC = "Helvetica-Oblique"
FONT_BOLD_ITALIC = "Helvetica-BoldOblique"

WPA_RULES_LANDING = "https://wpapool.com/rules/"
WPA_RULES_PDF = "https://wpapool.com/wp-content/uploads/2026/01/2026.01.02-WPA-Rules.pdf"
WPA_10BALL_ANCHOR = f"{WPA_RULES_PDF}#page=24"

H1_SIZE = 17
H2_SIZE = 12
H3_SIZE = 10.5
BODY_SIZE = 9.5
CAP_SIZE = 7.5
LEADING = 12
PARA_GAP = 5

# Chip taxonomy: (label, background rgb, primary font for the RULE, note)
CHIP = {
    "K":       ("K-Ball",         CHIP_BG_K,     FONT_BOLD_ITALIC, "K-Ball specific rule"),
    "K/10":    ("K-Ball · 10-Ball", CHIP_BG_ADAPT, FONT_BOLD,        "Adapted from 10-Ball"),
    "K/14.1":  ("K-Ball · 14.1",    CHIP_BG_ADAPT, FONT_BOLD,        "Adapted from 14.1"),
    "10":      ("10-Ball",        CHIP_BG_WPA,   FONT_BODY,        "From WPA 10-Ball"),
    "14.1":    ("14.1",           CHIP_BG_WPA,   FONT_BODY,        "From WPA 14.1 Continuous"),
    "Gen":     ("WPA General",    CHIP_BG_WPA,   FONT_BODY,        "From WPA general rules / fouls"),
}


class Cursor:
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
                     "K-BALL (15-BALL ROTATION) STANDARD RULES")
        c.drawRightString(PAGE_W - self.margin, PAGE_H - self.margin + 6,
                          "Columbia Cue Club")
        c.setStrokeColorRGB(*LIGHT_GRAY)
        c.setLineWidth(0.4)
        c.line(self.margin, PAGE_H - self.margin,
               PAGE_W - self.margin, PAGE_H - self.margin)
        c.setFillColorRGB(*BLACK)
        self.y = PAGE_H - self.margin - 8

    def _draw_footer(self) -> None:
        c = self.c
        c.setFont(FONT_BODY, 7.5)
        c.setFillColorRGB(*GRAY)
        c.drawString(self.margin, self.margin - 14,
                     "See WPA Rules of Play for cross-referenced general rules  ·  wpapool.com/rules/")
        c.drawRightString(PAGE_W - self.margin, self.margin - 14,
                          f"Page {self.page}")
        c.setFillColorRGB(*BLACK)


# ---------- Text primitives ----------

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
              leading=LEADING, indent=0.0, gap_after=PARA_GAP,
              max_w=None) -> None:
    c = cur.c
    if max_w is None:
        max_w = cur.col_w - indent
    lines = wrap_lines(text, font, size, max_w)
    total = leading * len(lines) + gap_after
    cur.need(total)
    c.setFont(font, size)
    c.setFillColorRGB(*BLACK)
    for ln in lines:
        c.drawString(cur.x + indent, cur.y - size, ln)
        cur.advance(leading)
    cur.advance(gap_after)


def draw_bulleted(cur: Cursor, items: list[str], *, indent=16.0,
                  bullet="•", size=BODY_SIZE, leading=LEADING) -> None:
    c = cur.c
    for item in items:
        max_w = cur.col_w - indent
        lines = wrap_lines(item, FONT_BODY, size, max_w)
        cur.need(leading * len(lines) + 2)
        c.setFont(FONT_BODY, size)
        c.setFillColorRGB(*BLACK)
        c.drawString(cur.x + indent - 10, cur.y - size, bullet)
        for ln in lines:
            c.drawString(cur.x + indent, cur.y - size, ln)
            cur.advance(leading)
        cur.advance(1)
    cur.advance(3)


def draw_lettered(cur: Cursor, items: list[str], *, indent=22.0,
                  size=BODY_SIZE, leading=LEADING) -> None:
    c = cur.c
    for i, item in enumerate(items):
        letter_label = f"({chr(ord('a') + i)})"
        max_w = cur.col_w - indent
        lines = wrap_lines(item, FONT_BODY, size, max_w)
        cur.need(leading * len(lines) + 2)
        c.setFont(FONT_BODY, size)
        c.setFillColorRGB(*BLACK)
        c.drawString(cur.x + indent - 22, cur.y - size, letter_label)
        for ln in lines:
            c.drawString(cur.x + indent, cur.y - size, ln)
            cur.advance(leading)
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


def draw_h2(cur: Cursor, num: str, text: str) -> None:
    cur.need(H2_SIZE + 14)
    c = cur.c
    c.setFont(FONT_BOLD, H2_SIZE)
    c.setFillColorRGB(*BLACK)
    label = f"{num}  {text}" if num else text
    c.drawString(cur.x, cur.y - H2_SIZE, label)
    cur.advance(H2_SIZE + 6)


def draw_chip(c: canvas.Canvas, x: float, y: float, source: str) -> float:
    """Draw a source chip and return its width."""
    label, bg, _rule_font, _note = CHIP[source]
    text = f"[{label}]"
    chip_font_size = 7.0
    pad_x = 4.0
    pad_y = 2.0
    tw = stringWidth(text, FONT_BOLD, chip_font_size)
    w = tw + 2 * pad_x
    h = chip_font_size + 2 * pad_y
    c.setFillColorRGB(*bg)
    c.setStrokeColorRGB(*LIGHT_GRAY)
    c.setLineWidth(0.4)
    c.roundRect(x, y - h + 2, w, h, 2, stroke=1, fill=1)
    c.setFillColorRGB(*BLACK)
    c.setFont(FONT_BOLD, chip_font_size)
    c.drawString(x + pad_x, y - chip_font_size + pad_y, text)
    return w


def draw_h3(cur: Cursor, num: str, text: str, source: str) -> None:
    """Rule heading with source chip. Font weight of the RULE TITLE
    varies by source per CHIP[source][2]."""
    cur.need(H3_SIZE + 10)
    c = cur.c
    _label, _bg, rule_font, _note = CHIP[source]
    c.setFont(rule_font, H3_SIZE)
    c.setFillColorRGB(*BLACK)
    label = f"{num}  {text}"
    tw = stringWidth(label, rule_font, H3_SIZE)
    c.drawString(cur.x, cur.y - H3_SIZE, label)
    # Chip to the right of the heading
    chip_x = cur.x + tw + 8
    chip_y = cur.y - 1
    draw_chip(c, chip_x, chip_y, source)
    cur.advance(H3_SIZE + 6)


# ---------- Cover page ----------

def draw_cover(c: canvas.Canvas) -> None:
    c.setFillColorRGB(*BLACK)
    c.setFont(FONT_BOLD, 32)
    c.drawString(MARGIN, PAGE_H - MARGIN - 40, "K-BALL")
    c.setFont(FONT_BODY, 16)
    c.drawString(MARGIN, PAGE_H - MARGIN - 64, "15-Ball Rotation — Standard Rules")

    c.setFont(FONT_ITALIC, 10.5)
    c.setFillColorRGB(*GRAY)
    c.drawString(MARGIN, PAGE_H - MARGIN - 84,
                 "House rules for Columbia Cue Club, structured in the style of the WPA Rules of Play.")

    box_x = MARGIN
    box_y_top = PAGE_H - MARGIN - 130
    box_h = 200
    box_w = PAGE_W - 2 * MARGIN
    c.setStrokeColorRGB(*BLACK)
    c.setLineWidth(1.2)
    c.rect(box_x, box_y_top - box_h, box_w, box_h, stroke=1, fill=0)

    inner_pad = 20
    y = box_y_top - inner_pad - 4
    c.setFillColorRGB(*BLACK)
    c.setFont(FONT_BOLD, 13)
    c.drawString(box_x + inner_pad, y, "WHAT IS K-BALL?")
    y -= 20

    c.setFont(FONT_BODY, 10.5)
    para = (
        "K-Ball is 15-ball rotation played to a target score. Fifteen numbered "
        "balls are racked and played in ascending numerical order. Every ball "
        "legally pocketed scores one point. The first player to reach the "
        "agreed target — 25 (recreational) or 50 (competitive) — wins the Match."
    )
    for line in wrap_lines(para, FONT_BODY, 10.5, box_w - 2 * inner_pad):
        c.drawString(box_x + inner_pad, y, line)
        y -= 14
    y -= 6

    c.setFont(FONT_BOLD, 13)
    c.drawString(box_x + inner_pad, y, "HOW K-BALL COMBINES 10-BALL AND 14.1")
    y -= 20
    c.setFont(FONT_BODY, 10.5)
    para2 = (
        "K-Ball borrows rotation order and standard fouls from WPA 10-Ball, "
        "and 1-point-per-ball, race-to-N scoring from WPA 14.1 Continuous Pool. "
        "Unlike 10-Ball, called shots are not required. Unlike 14.1, balls must "
        "be contacted in numerical order. All other WPA general rules apply unchanged."
    )
    for line in wrap_lines(para2, FONT_BODY, 10.5, box_w - 2 * inner_pad):
        c.drawString(box_x + inner_pad, y, line)
        y -= 14

    # Sourcing legend
    legend_y = box_y_top - box_h - 28
    c.setFont(FONT_BOLD, 10)
    c.setFillColorRGB(*BLACK)
    c.drawString(MARGIN, legend_y, "HOW TO READ THIS DOCUMENT")
    legend_y -= 16

    c.setFont(FONT_BODY, 9)
    c.drawString(MARGIN, legend_y,
                 "Every rule heading carries a source chip. Look for these:")
    legend_y -= 16

    # Draw chip legend row
    legend_items = [
        ("K",      "New K-Ball rule — bold italic heading. The reader's key differences."),
        ("K/10",   "Adapted from WPA 10-Ball with a K-Ball change — bold heading."),
        ("K/14.1", "Adapted from WPA 14.1 Continuous with a K-Ball change — bold heading."),
        ("10",     "Unchanged from WPA 10-Ball (cross-referenced, not reproduced)."),
        ("14.1",   "Unchanged from WPA 14.1 Continuous (cross-referenced, not reproduced)."),
        ("Gen",    "Unchanged from WPA general rules or fouls (cross-referenced)."),
    ]
    lx = MARGIN
    for src, note in legend_items:
        chip_w = draw_chip(c, lx, legend_y + 8, src)
        c.setFont(FONT_BODY, 8)
        c.setFillColorRGB(*BLACK)
        c.drawString(lx + chip_w + 6, legend_y + 1, note)
        legend_y -= 14

    # QR at bottom-right
    qr_size = 84
    qr_x = PAGE_W - MARGIN - qr_size
    qr_y = MARGIN + 30
    draw_qr(c, qr_x, qr_y, qr_size, WPA_10BALL_ANCHOR)
    c.setFont(FONT_BOLD, 8.5)
    c.setFillColorRGB(*BLACK)
    c.drawRightString(PAGE_W - MARGIN, qr_y - 10, "Scan: WPA Rules of Play (10-Ball, p. 24)")
    c.setFont(FONT_BODY, 8)
    c.setFillColorRGB(*GRAY)
    c.drawRightString(PAGE_W - MARGIN, qr_y - 22, "wpapool.com/rules/")

    # Version block bottom-left
    c.setFillColorRGB(*BLACK)
    c.setFont(FONT_BOLD, 9)
    c.drawString(MARGIN, MARGIN + 60, "VERSION")
    c.setFont(FONT_BODY, 9)
    c.drawString(MARGIN, MARGIN + 46, "K-Ball Rules v1.0")
    c.setFont(FONT_BOLD, 9)
    c.drawString(MARGIN, MARGIN + 28, "EFFECTIVE")
    c.setFont(FONT_BODY, 9)
    c.drawString(MARGIN, MARGIN + 14, "August 2026")
    c.setFont(FONT_BODY, 7.5)
    c.setFillColorRGB(*GRAY)
    c.drawString(MARGIN, MARGIN - 4,
                 "Aligned to the WPA Rules of Play, effective 2025-09-15.")
    c.setFillColorRGB(*BLACK)

    c.showPage()


# ---------- What's-new summary page ----------

def draw_whats_new(cur: Cursor) -> None:
    draw_h1(cur, "WHAT’S NEW IN K-BALL")

    draw_para(cur,
        "If you already know 10-Ball or 14.1, these are the K-Ball-specific "
        "rules to learn. Each one is marked [K-Ball] in the body of this "
        "document. All other rules are pointers into the current WPA Rules "
        "of Play.")

    items = [
        ("K.2  The Rack",
         "The 1-ball on the Foot Spot at the apex, the 8-ball in the center "
         "of the triangle, the 15-ball and remaining balls placed randomly."),
        ("K.5  Shots Are Not Called",
         "Slop counts. Any legal contact with the lowest-numbered ball that "
         "results in a pocketed ball scores that ball, regardless of which "
         "pocket or combination produced it. A declared safety still passes "
         "the turn."),
        ("K.8  Scoring — 1 Point per Ball, Race to Target",
         "Each ball legally pocketed = 1 point. Each foul = −1 point. The "
         "Match ends the moment a player’s SUBTOTAL reaches the target "
         "(25 or 50) on a legal shot; no single ball is the winning ball. "
         "Any additional balls pocketed in that winning rack may be "
         "recorded to a higher FINAL total for personal-best or high-score "
         "purposes, but do not affect who won or when."),
        ("K.6  No Special Spotting",
         "Unlike WPA 10-Ball, there is no rule that spots the highest ball "
         "when pocketed on a foul. Any ball pocketed on a foul or safety is "
         "spotted per WPA 1.5 like any other ball."),
        ("K.7  Continuing Play Across Racks",
         "When the 15-ball is legally pocketed, the balls are re-racked and "
         "the shooter continues with a new break under K.3. The Match does "
         "not end at rack boundaries — only when the target score is reached."),
    ]
    for title, body in items:
        cur.need(28)
        cur.c.setFont(FONT_BOLD_ITALIC, 10.5)
        cur.c.setFillColorRGB(*BLACK)
        cur.c.drawString(cur.x, cur.y - 10.5, title)
        # chip
        tw = stringWidth(title, FONT_BOLD_ITALIC, 10.5)
        draw_chip(cur.c, cur.x + tw + 8, cur.y - 1, "K")
        cur.advance(14)
        draw_para(cur, body, indent=12)


# ---------- Body sections ----------

def draw_body(c: canvas.Canvas) -> None:
    cur = Cursor(c)
    cur._draw_page_header()

    # ===== Section 1: General =====
    draw_h1(cur, "1.  GENERAL")

    draw_h2(cur, "1.1", "APPLICABILITY OF THE WPA GENERAL RULES")
    draw_para(cur,
        "All rules in WPA Section 1 (General Rules) apply to K-Ball unchanged. "
        "This includes WPA 1.1 Player’s Responsibility, 1.2 Lagging to Determine "
        "First Break, 1.3 Subsequent Breaks, 1.4 Player’s Use of Equipment, "
        "1.5 Spotting Balls, 1.6 Cue-Ball in Hand, 1.8 Balls Settling, "
        "1.9 Restoring a Position, 1.10 Outside Interference, 1.11 Prompting "
        "Calls and Protesting Rulings, 1.12 Concession, and 1.13 Stalemate. "
        "WPA 1.7 Standard Call Shot does NOT apply because K-Ball is not a "
        "call-shot Discipline (see K.5 below).")

    draw_h2(cur, "1.2", "APPLICABILITY OF THE WPA FOULS")
    draw_para(cur,
        "All fouls defined in WPA Section 3 (Fouls) apply to K-Ball as listed "
        "under K.9 (Standard Fouls) and K.10 (Serious Fouls). Any WPA foul "
        "not explicitly listed nevertheless remains in force where relevant "
        "to normal play.")

    draw_h2(cur, "1.3", "GAME OVERVIEW")
    draw_para(cur,
        "K-Ball is a rotation Discipline played with fifteen object-balls "
        "numbered 1 through 15 and the cue-ball. The object-balls are played "
        "in ascending numerical order. Each legally pocketed ball counts one "
        "point. The first player to reach the target score wins the Match. "
        "The standard targets are 25 points (recreational) and 50 points "
        "(competitive). Any other target may be agreed to before the Match "
        "and, when different from 25 or 50, must be noted on the score sheet.")

    # ===== Section 2: What's New (page break) =====
    cur.page_break()
    draw_whats_new(cur)

    # ===== Section K: The Discipline =====
    cur.page_break()
    draw_h1(cur, "K.  K-BALL (15-BALL ROTATION)")

    draw_para(cur,
        "K-Ball is a rotation Discipline played with fifteen object-balls "
        "numbered 1 through 15 and the cue-ball. The object-balls must be "
        "contacted in ascending numerical order (rotation). Each ball legally "
        "pocketed counts one point, and the first player to reach the target "
        "score wins the Match. Called shots are not required.")

    # --- New K-Ball rules (bold italic, [K] chip) come first ---

    draw_h3(cur, "K.2", "THE RACK", "K")
    draw_para(cur,
        "The fifteen object-balls are racked as tightly as possible in a "
        "triangular shape:")
    draw_lettered(cur, [
        "The 1-ball is at the apex of the triangle, on the Foot Spot.",
        "The 8-ball is placed in the center of the triangle.",
        "The 15-ball and the remaining object-balls are placed without "
        "purposeful or intentional pattern.",
    ])

    draw_h3(cur, "K.5", "SHOTS ARE NOT CALLED", "K")
    draw_para(cur,
        "K-Ball is NOT a call-shot Discipline. A ball is legally pocketed "
        "whenever the cue-ball first contacts the lowest-numbered ball "
        "remaining on the table and any object-ball is subsequently pocketed "
        "without a foul, regardless of which pocket, cushion route, or "
        "combination produced the pocketing. Slop counts. The shooter may, "
        "however, declare “safety” before any shot; if declared, play passes "
        "to the opponent at the end of the shot even if a ball is pocketed, "
        "and any pocketed object-ball is spotted per WPA 1.5.")

    draw_h3(cur, "K.6", "SPOTTING BALLS", "K")
    draw_para(cur,
        "Balls are spotted per WPA 1.5. K-Ball has no special provision "
        "for the highest-numbered ball; the 15-ball is treated like any "
        "other object-ball. If it is pocketed on a foul or on a declared "
        "safety, it is spotted per WPA 1.5.")

    draw_h3(cur, "K.7", "CONTINUING PLAY", "K")
    draw_para(cur,
        "If the shooter legally pockets at least one object-ball on a shot "
        "and does not foul, the shooter continues at the table. If the "
        "shooter misses, plays a safety, or fouls, play passes to the "
        "opponent. When the 15-ball is legally pocketed, all fifteen balls "
        "are re-racked (see K.2) and the player whose turn it is continues "
        "shooting, breaking the new rack under the requirements of K.3. "
        "The Match does not end at rack boundaries; it ends only when a "
        "player reaches the target score.")

    draw_h3(cur, "K.8", "SCORING", "K")
    draw_lettered(cur, [
        "Each object-ball legally pocketed scores one point for the shooter.",
        "Each foul subtracts one point from the offending player’s score. "
        "Only one foul penalty is assessed per shot, even when multiple "
        "infractions occur (per WPA 3).",
        "The Match ends the moment a player’s SUBTOTAL first reaches the "
        "agreed target score on a legal shot. Any legal ball may be the "
        "winning ball; there is no dedicated “money ball” (contrast WPA "
        "10-Ball, where only the 10-ball wins).",
        "Once a player has reached the target, any additional balls pocketed "
        "in that same winning rack may be recorded to a higher FINAL total "
        "for personal-best or house high-score purposes. This does not "
        "change who won, nor when the Match ended; the record is simply a "
        "courtesy for the winning player. Recording extra balls is "
        "optional; if either player prefers, play stops at the target.",
        "The standard targets are 25 points (recreational) and 50 points "
        "(competitive). Any other target may be agreed to before the "
        "Match starts and must be noted on the score sheet.",
    ])

    # --- Adapted-from-10-Ball rules ([K/10] chip, bold) ---

    draw_h3(cur, "K.3", "LEGAL BREAK SHOT", "K/10")
    draw_lettered(cur, [
        "The cue-ball begins in hand above the Head String (see WPA 1.6 "
        "Cue-Ball in Hand and WPA 3.10 Bad Cue-Ball Placement).",
        "The first object-ball contacted by the cue-ball must be the 1-ball.",
        "If no object-ball is pocketed, at least four object-balls must be "
        "driven to one or more rails, or the shot is a foul (see K.9).",
        "Pocketing the 1-ball on the break scores one point for the breaker "
        "and continues the inning. Pocketing any other ball on a legal break "
        "also scores one point per ball and continues the inning.",
    ])

    draw_h3(cur, "K.1", "DETERMINING THE BREAK", "K/10")
    draw_para(cur,
        "Players lag as described in WPA 1.2 (Lagging to Determine First "
        "Break). The player who wins the lag chooses who will break the first "
        "Rack. Subsequent breaks alternate between players (WPA 1.3).")

    draw_h3(cur, "K.4", "SECOND SHOT OF THE RACK — PUSH OUT", "K/10")
    draw_para(cur,
        "If no foul is committed on the break shot, the shooter may choose "
        "to play a “push out.” The player must inform the referee (or, in "
        "unofficiated play, the opponent) before the shot; then WPA 3.2 "
        "(Wrong Ball First) and WPA 3.3 (No Rail after Contact) are suspended "
        "for that shot. Balls pocketed on a push out do NOT score and are "
        "spotted per WPA 1.5. If no foul is committed on the push out, the "
        "other player chooses who will shoot next.")

    # --- Unchanged WPA rules ([Gen] / [10] chips, regular weight) ---

    draw_h3(cur, "K.9", "STANDARD FOULS", "Gen")
    draw_para(cur,
        "If the shooter commits a standard foul, one point is subtracted "
        "from his score, and play passes to the opponent. The cue-ball is "
        "in hand for the incoming player, who may place it anywhere on the "
        "playing surface (see WPA 1.6). The following standard fouls apply "
        "at K-Ball; refer to the WPA Rules of Play for the definitive text:")
    draw_bulleted(cur, [
        "WPA 3.1  Cue-Ball Scratch or Off the Table.",
        "WPA 3.2  Wrong Ball First — the first object-ball contacted by "
        "the cue-ball on each shot must be the lowest-numbered ball "
        "remaining on the table.",
        "WPA 3.3  No Rail after Contact.",
        "WPA 3.4  No Foot on Floor.",
        "WPA 3.5  Ball Driven Off the Table — all such balls are spotted.",
        "WPA 3.6  Touched Ball.",
        "WPA 3.7  Double Hit / Frozen Balls.",
        "WPA 3.8  Push Shot.",
        "WPA 3.9  Balls Still Moving.",
        "WPA 3.10 Bad Cue-Ball Placement.",
        "WPA 3.12 Playing Out of Turn.",
        "WPA 3.14 Slow Play.",
        "WPA 3.15 Ball Rack Template Foul.",
    ])

    draw_h3(cur, "K.10", "SERIOUS FOULS", "Gen")
    draw_para(cur,
        "For WPA 3.13 (Three Consecutive Fouls), the penalty is loss of "
        "the current Rack: all balls in the current rack are re-racked, "
        "the offending player’s consecutive-foul count is reset, and the "
        "offending player must break under K.3. For WPA 3.16 "
        "(Unsportsmanlike Conduct), the referee — or, in unofficiated "
        "play, mutual agreement of the players — will choose a penalty "
        "appropriate to the offense, up to and including forfeiture of "
        "the Match.")

    draw_h3(cur, "K.11", "STALEMATE", "Gen")
    draw_para(cur,
        "If a stalemate occurs as described in WPA 1.13, the original "
        "breaker of the current Rack breaks again under K.3. Points scored "
        "prior to the stalemate remain in effect.")

    # ===== Appendix A: comparison =====
    cur.page_break()
    draw_h1(cur, "APPENDIX A — COMPARISON WITH 10-BALL AND 14.1")

    draw_para(cur,
        "The table below summarises how K-Ball relates to the two WPA "
        "disciplines it borrows from. K-Ball adopts rotation and standard "
        "fouls from 10-Ball, and 1-point-per-ball / race-to-target scoring "
        "from 14.1. It differs from both parents in that shots are NOT "
        "called (see K.5) and no single ball is a “winning ball” (see K.8).")

    _draw_comparison_table(cur)

    # ===== Appendix B: worked examples =====
    draw_h1(cur, "APPENDIX B — WORKED SCORING EXAMPLES")

    draw_para(cur,
        "The examples below illustrate how points and fouls combine over a "
        "series of racks. Each example assumes a race to 25.")

    draw_h3(cur, "B.1", "Simple run of three racks", "K")
    draw_bulleted(cur, [
        "Rack 1: Player A legally pockets 8 balls, then misses. RACK TOTAL = 8. "
        "Player B pockets the remaining 7. Rack 1 GAME SUBTOTAL: A = 8, B = 7.",
        "Rack 2: A pockets 10 balls (including one bank shot — slop counts), "
        "then commits a scratch foul on the 12-ball. RACK TOTAL = 10 − 1 = 9. "
        "B pockets the remaining 5. Rack 2 SUBTOTAL: A = 8 + 9 = 17, B = 7 + 5 = 12.",
        "Rack 3: B breaks and pockets 13 balls in a row. B’s SUBTOTAL hits "
        "25 on the ball that took B from 24 to 25 — B wins the Match at "
        "that instant. B chooses to continue and pocket the last 2 balls "
        "of the rack for a FINAL total of 27, recorded as high score. "
        "A’s FINAL = 17.",
    ])

    draw_h3(cur, "B.2", "Foul penalty near a low score", "K")
    draw_para(cur,
        "A score may go negative from foul penalties (per WPA 14.1 "
        "tradition). If a player is at 0 and commits a foul, that player’s "
        "SUBTOTAL becomes −1. Recording is straightforward on the score "
        "sheet: enter the negative RACK TOTAL and carry it forward to "
        "the next SUBTOTAL cell.")

    # ===== Appendix C: cross-reference index =====
    cur.page_break()
    draw_h1(cur, "APPENDIX C — WPA CROSS-REFERENCE INDEX")

    draw_para(cur,
        "Every WPA rule cited in this document is listed below with its "
        "WPA section number. Scan the QR on the cover (or visit "
        "wpapool.com/rules/) to open the current WPA Rules of Play PDF, "
        "where these sections appear verbatim.")

    xref = [
        ("WPA 1.2",  "Lagging to Determine First Break",  "cited in K.1"),
        ("WPA 1.3",  "Subsequent Breaks",                 "cited in K.1"),
        ("WPA 1.5",  "Spotting Balls",                    "cited in K.4, K.6"),
        ("WPA 1.6",  "Cue-Ball in Hand",                  "cited in K.3, K.9"),
        ("WPA 1.7",  "Standard Call Shot",                "NOT applied (see K.5)"),
        ("WPA 1.13", "Stalemate",                         "cited in K.11"),
        ("WPA 3.1",  "Cue-Ball Scratch or Off the Table", "standard foul at K-Ball"),
        ("WPA 3.2",  "Wrong Ball First",                  "standard foul (lowest ball first)"),
        ("WPA 3.3",  "No Rail after Contact",             "standard foul at K-Ball"),
        ("WPA 3.4",  "No Foot on Floor",                  "standard foul at K-Ball"),
        ("WPA 3.5",  "Ball Driven Off the Table",         "standard foul at K-Ball"),
        ("WPA 3.6",  "Touched Ball",                      "standard foul at K-Ball"),
        ("WPA 3.7",  "Double Hit / Frozen Balls",         "standard foul at K-Ball"),
        ("WPA 3.8",  "Push Shot",                         "standard foul at K-Ball"),
        ("WPA 3.9",  "Balls Still Moving",                "standard foul at K-Ball"),
        ("WPA 3.10", "Bad Cue-Ball Placement",            "standard foul at K-Ball"),
        ("WPA 3.12", "Playing Out of Turn",               "standard foul at K-Ball"),
        ("WPA 3.13", "Three Consecutive Fouls",           "serious foul at K-Ball (K.10)"),
        ("WPA 3.14", "Slow Play",                         "standard foul at K-Ball"),
        ("WPA 3.15", "Ball Rack Template Foul",           "standard foul at K-Ball"),
        ("WPA 3.16", "Unsportsmanlike Conduct",           "serious foul at K-Ball (K.10)"),
    ]
    _draw_xref_table(cur, xref)

    cur._draw_footer()


def _draw_comparison_table(cur: Cursor) -> None:
    c = cur.c
    rows = [
        ("",              "K-Ball",              "10-Ball (WPA 6)",     "14.1 (WPA 7)"),
        ("Object-balls",  "1 through 15",        "1 through 10",        "1 through 15"),
        ("Play order",    "Rotation (lowest)",   "Rotation (lowest)",   "Any legal ball"),
        ("Call shots?",   "No",                  "Yes",                 "Yes"),
        ("Scoring",       "1 pt per ball",       "Winning-ball only",   "1 pt per ball"),
        ("Win condition", "First to reach target", "Legally pocket 10",   "First to reach target"),
        ("Foul penalty",  "−1 point, BIH",       "BIH (rack-based)",    "−1 point, BIH-above"),
        ("Race target",   "25 or 50",            "N/A (rack-based)",    "Match-dependent"),
        ("Re-rack when",  "15 pocketed",         "After each rack",     "14 pocketed (keep 15th)"),
        ("Rack apex",     "1-ball, 8 in center", "1-ball, 10 in center", "Apex ball (varies)"),
    ]
    col_widths = [90, 130, 130, 130]
    row_h = 16
    total_w = sum(col_widths)
    if total_w > cur.col_w:
        scale = cur.col_w / total_w
        col_widths = [w * scale for w in col_widths]
    cur.need(row_h * len(rows) + 10)
    y0 = cur.y

    for r_idx, row in enumerate(rows):
        x = cur.x
        for c_idx, cell in enumerate(row):
            w = col_widths[c_idx]
            c.setStrokeColorRGB(*LIGHT_GRAY)
            c.setLineWidth(0.4)
            c.rect(x, y0 - (r_idx + 1) * row_h, w, row_h, stroke=1, fill=0)
            font = FONT_BOLD if r_idx == 0 or c_idx == 0 else FONT_BODY
            size = 9
            c.setFont(font, size)
            c.setFillColorRGB(*BLACK)
            c.drawString(x + 5, y0 - r_idx * row_h - 11, cell)
            x += w

    cur.advance(row_h * len(rows) + 8)


def _draw_xref_table(cur: Cursor, rows: list[tuple[str, str, str]]) -> None:
    c = cur.c
    col_widths = [70, 220, 200]
    row_h = 14
    total_w = sum(col_widths)
    if total_w > cur.col_w:
        scale = cur.col_w / total_w
        col_widths = [w * scale for w in col_widths]

    hdr = ("WPA §", "Rule", "Used in K-Ball as")
    cur.need(row_h * (len(rows) + 1) + 10)

    # Header row
    x = cur.x
    c.setFont(FONT_BOLD, 9)
    c.setFillColorRGB(*BLACK)
    for i, cell in enumerate(hdr):
        c.drawString(x + 4, cur.y - 11, cell)
        x += col_widths[i]
    # Underline UNDER the header text
    header_bottom = cur.y - row_h
    c.setStrokeColorRGB(*BLACK)
    c.setLineWidth(0.6)
    c.line(cur.x, header_bottom + 2, cur.x + sum(col_widths), header_bottom + 2)
    cur.advance(row_h)

    # Data rows
    for row in rows:
        cur.need(row_h)
        x = cur.x
        for i, cell in enumerate(row):
            font = FONT_BOLD if i == 0 else FONT_BODY
            c.setFont(font, 9)
            c.drawString(x + 4, cur.y - 11, cell)
            x += col_widths[i]
        cur.advance(row_h)

    cur.advance(6)


def build(out_path: str) -> None:
    c = canvas.Canvas(out_path, pagesize=letter)
    c.setAuthor("Columbia Cue Club")
    c.setTitle("K-Ball (15-Ball Rotation) Standard Rules")
    c.setSubject("K-Ball rules in the style of the WPA Rules of Play.")
    c.setCreator("kball-scoresheet docs/build_kball_rules.py")

    draw_cover(c)
    draw_body(c)

    c.save()
    print(f"Wrote {out_path}")


def main() -> None:
    build(OUT)


if __name__ == "__main__":
    main()

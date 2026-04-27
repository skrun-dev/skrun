#!/usr/bin/env python3
"""Render a multi-page executive PDF report (matplotlib charts + ReportLab layout).

Input  (stdin JSON):  { report_title, period, narrative_sections, charts, summary_table? }
Output (stdout JSON): { path, bytes, page_count }
"""

from __future__ import annotations

import io
import json
import os
import sys
from pathlib import Path

try:
    import matplotlib
    matplotlib.use("Agg")  # non-interactive — required when no display is available
    import matplotlib.pyplot as plt
    from reportlab.lib.colors import HexColor
    from reportlab.lib.pagesizes import letter
    from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
    from reportlab.lib.units import inch
    from reportlab.platypus import (
        Image,
        PageBreak,
        Paragraph,
        SimpleDocTemplate,
        Spacer,
        Table,
        TableStyle,
    )
    from reportlab.lib import colors as rl_colors
except ImportError as e:
    print(json.dumps({
        "error": f"required deps not installed: {e}. Run: pip install -r requirements.txt"
    }))
    sys.exit(0)


BRAND = HexColor("#0366d6")
MUTED = HexColor("#666666")


def render_chart_to_buffer(chart: dict) -> io.BytesIO:
    """Render one chart spec to a PNG in memory, return the buffer."""
    title = chart.get("title", "")
    ctype = chart.get("chart_type", "bar")
    x_labels = chart.get("x_labels", [])
    series = chart.get("series", [])

    fig, ax = plt.subplots(figsize=(7, 3.6), dpi=120)
    fig.patch.set_facecolor("white")

    if ctype == "pie" and series:
        values = series[0].get("values", [])
        ax.pie(values, labels=x_labels, autopct="%1.0f%%", startangle=90, counterclock=False)
        ax.axis("equal")
    elif ctype == "line":
        for s in series:
            ax.plot(x_labels, s.get("values", []), marker="o", label=s.get("name", ""))
        if len(series) > 1:
            ax.legend(loc="upper left", frameon=False)
        ax.grid(True, alpha=0.3)
    else:  # bar
        if len(series) == 1:
            ax.bar(x_labels, series[0].get("values", []), color="#0366d6")
        else:
            import numpy as np
            x = np.arange(len(x_labels))
            width = 0.8 / max(1, len(series))
            for i, s in enumerate(series):
                offset = (i - (len(series) - 1) / 2) * width
                ax.bar(x + offset, s.get("values", []), width=width, label=s.get("name", ""))
            ax.set_xticks(x)
            ax.set_xticklabels(x_labels)
            ax.legend(loc="upper left", frameon=False)
        ax.grid(True, axis="y", alpha=0.3)

    if ctype != "pie":
        # Rotate x labels if many
        if len(x_labels) > 6:
            for label in ax.get_xticklabels():
                label.set_rotation(45)
                label.set_horizontalalignment("right")

    ax.set_title(title, fontsize=12, color="#1a1a1a", pad=10, loc="left")
    ax.spines["top"].set_visible(False)
    ax.spines["right"].set_visible(False)
    plt.tight_layout()

    buf = io.BytesIO()
    fig.savefig(buf, format="png", bbox_inches="tight")
    plt.close(fig)
    buf.seek(0)
    return buf


def main() -> None:
    raw = sys.stdin.read()
    try:
        args = json.loads(raw)
    except json.JSONDecodeError as e:
        print(json.dumps({"error": f"invalid stdin JSON: {e}"}))
        return

    report_title = args.get("report_title", "Untitled Report")
    period = args.get("period", "")
    narrative_sections = args.get("narrative_sections", [])
    charts = args.get("charts", [])
    summary_table = args.get("summary_table", [])

    if not isinstance(narrative_sections, list):
        narrative_sections = []
    if not isinstance(charts, list):
        charts = []
    if not isinstance(summary_table, list):
        summary_table = []

    output_dir = os.environ.get("SKRUN_OUTPUT_DIR")
    if not output_dir:
        print(json.dumps({"error": "SKRUN_OUTPUT_DIR is not set"}))
        return

    Path(output_dir).mkdir(parents=True, exist_ok=True)
    out_path = Path(output_dir) / "report.pdf"

    doc = SimpleDocTemplate(
        str(out_path),
        pagesize=letter,
        topMargin=0.75 * inch,
        bottomMargin=0.75 * inch,
        leftMargin=0.75 * inch,
        rightMargin=0.75 * inch,
        title=report_title,
    )

    styles = getSampleStyleSheet()
    title_style = ParagraphStyle(
        "title",
        parent=styles["Title"],
        textColor=BRAND,
        spaceAfter=8,
    )
    subtitle_style = ParagraphStyle(
        "subtitle",
        parent=styles["Normal"],
        fontSize=12,
        textColor=MUTED,
        spaceAfter=24,
    )
    section_h = ParagraphStyle(
        "section_h",
        parent=styles["Heading2"],
        textColor=BRAND,
        spaceBefore=18,
        spaceAfter=8,
    )
    body_style = ParagraphStyle(
        "body",
        parent=styles["Normal"],
        fontSize=11,
        leading=16,
        spaceAfter=8,
    )

    story: list = []

    # --- Page 1: title + headline narrative + first chart ---
    story.append(Paragraph(report_title, title_style))
    story.append(Paragraph(period, subtitle_style))

    sections_iter = iter(narrative_sections)
    first = next(sections_iter, None)
    if first is not None:
        story.append(Paragraph(first.get("heading", "Summary"), section_h))
        story.append(Paragraph(first.get("body", ""), body_style))

    if charts:
        first_chart = charts[0]
        try:
            buf = render_chart_to_buffer(first_chart)
            story.append(Spacer(1, 12))
            story.append(Image(buf, width=6.5 * inch, height=3.3 * inch))
        except Exception:
            pass

    # --- Subsequent pages: rest of sections + remaining charts ---
    rest_charts = charts[1:]
    chart_idx = 0
    for section in sections_iter:
        story.append(PageBreak())
        story.append(Paragraph(section.get("heading", ""), section_h))
        story.append(Paragraph(section.get("body", ""), body_style))
        if chart_idx < len(rest_charts):
            try:
                buf = render_chart_to_buffer(rest_charts[chart_idx])
                story.append(Spacer(1, 12))
                story.append(Image(buf, width=6.5 * inch, height=3.3 * inch))
            except Exception:
                pass
            chart_idx += 1

    # Any unattached charts → put each on its own page
    while chart_idx < len(rest_charts):
        story.append(PageBreak())
        try:
            buf = render_chart_to_buffer(rest_charts[chart_idx])
            story.append(Image(buf, width=6.5 * inch, height=3.3 * inch))
        except Exception:
            pass
        chart_idx += 1

    # --- Final page: summary table ---
    if summary_table:
        story.append(PageBreak())
        story.append(Paragraph("Summary", section_h))
        # Pad each row to ensure 2 cells.
        rows = [[r[0] if len(r) > 0 else "", r[1] if len(r) > 1 else ""] for r in summary_table]
        tbl = Table(rows, colWidths=[2.5 * inch, 3.5 * inch])
        tbl.setStyle(
            TableStyle([
                ("BACKGROUND", (0, 0), (0, -1), HexColor("#f6f8fa")),
                ("TEXTCOLOR", (0, 0), (0, -1), HexColor("#1a1a1a")),
                ("FONTNAME", (0, 0), (0, -1), "Helvetica-Bold"),
                ("FONTSIZE", (0, 0), (-1, -1), 11),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 8),
                ("TOPPADDING", (0, 0), (-1, -1), 8),
                ("LINEBELOW", (0, 0), (-1, -1), 0.5, rl_colors.lightgrey),
            ])
        )
        story.append(tbl)

    # Track number of pages by counting page break events as we build.
    # ReportLab's SimpleDocTemplate doesn't expose the count cleanly; we approximate
    # by counting PageBreaks + 1 (for the first page).
    page_count = 1 + sum(1 for x in story if isinstance(x, PageBreak))

    doc.build(story)
    size = out_path.stat().st_size
    print(json.dumps({"path": str(out_path), "bytes": size, "page_count": page_count}))


if __name__ == "__main__":
    main()

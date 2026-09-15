"""quote -> PyMuPDF rects for highlighting."""

import re

import fitz

_WHITESPACE_RE = re.compile(r"\s+")


def _normalize(text: str) -> str:
    return _WHITESPACE_RE.sub(" ", text).strip()


def _first_words(text: str, n: int) -> str:
    words = _normalize(text).split(" ")
    return " ".join(words[:n])


def _first_line(text: str) -> str:
    line = text.splitlines()[0] if text else ""
    return _normalize(line)


def _rects_to_lists(rects) -> list[list[float]]:
    return [[r.x0, r.y0, r.x1, r.y1] for r in rects]


def find_rects(pdf_path: str, page_no: int, quote: str, chunk_text: str) -> dict:
    doc = fitz.open(pdf_path)
    page = doc[page_no - 1]
    page_width, page_height = page.rect.width, page.rect.height

    quote_norm = _normalize(quote)
    attempts = [
        ("full quote", quote_norm),
        ("first 8 words of quote", _first_words(quote_norm, 8)),
        ("first 5 words of quote", _first_words(quote_norm, 5)),
        ("first 6 words of chunk", _first_words(chunk_text, 6)),
        ("chunk first line", _first_line(chunk_text)),
    ]

    for label, text in attempts:
        if not text:
            continue
        found = page.search_for(text)
        if found:
            print(f"[highlight] page {page_no}: matched via {label} -> {text!r}")
            doc.close()
            return {
                "rects": _rects_to_lists(found),
                "page_width": page_width,
                "page_height": page_height,
            }

    print(f"[highlight] page {page_no}: no match found for any strategy, falling back to full page rect")
    doc.close()
    return {
        "rects": [[0.0, 0.0, page_width, page_height]],
        "page_width": page_width,
        "page_height": page_height,
    }

"""PDF -> pages -> chunks with page numbers."""

import re
import sys

import fitz  # PyMuPDF

TARGET_CHARS = 900
OVERLAP_CHARS = 150
MIN_CHUNK_CHARS = 50

_BLANK_LINE_RE = re.compile(r"\n\s*\n+")
_WHITESPACE_RE = re.compile(r"\s+")
_SENTENCE_SPLIT_RE = re.compile(r"(?<=[.!?])\s+")


def _normalize(text: str) -> str:
    return _WHITESPACE_RE.sub(" ", text).strip()


def _split_long_paragraph(paragraph: str, target: int) -> list[str]:
    sentences = _SENTENCE_SPLIT_RE.split(paragraph)
    pieces = []
    current = ""
    for sentence in sentences:
        if not current:
            current = sentence
        elif len(current) + 1 + len(sentence) <= target:
            current = f"{current} {sentence}"
        else:
            pieces.append(current)
            current = sentence
    if current:
        pieces.append(current)
    return pieces


def _page_pieces(page_text: str, target: int) -> list[str]:
    paragraphs = [_normalize(p) for p in _BLANK_LINE_RE.split(page_text)]
    paragraphs = [p for p in paragraphs if p]

    pieces = []
    for paragraph in paragraphs:
        if len(paragraph) <= target:
            pieces.append(paragraph)
        else:
            pieces.extend(_split_long_paragraph(paragraph, target))
    return pieces


def _overlap_tail(text: str, overlap: int) -> str:
    if len(text) <= overlap:
        return text
    tail = text[-overlap:]
    space_idx = tail.find(" ")
    if space_idx != -1:
        tail = tail[space_idx + 1 :]
    return tail


def _chunk_pieces(pieces: list[str], target: int, overlap: int) -> list[str]:
    chunks = []
    current = ""
    for piece in pieces:
        if not current:
            current = piece
        elif len(current) + 1 + len(piece) <= target:
            current = f"{current} {piece}"
        else:
            chunks.append(current)
            tail = _overlap_tail(current, overlap)
            current = f"{tail} {piece}".strip() if tail else piece
    if current:
        chunks.append(current)
    return chunks


def ingest_pdf(path: str, on_page=None) -> list[dict]:
    """on_page(done, total) fires after each page is parsed, for progress reporting."""
    doc = fitz.open(path)
    chunks = []
    next_id = 0

    for page_index in range(doc.page_count):
        page = doc[page_index]
        page_no = page_index + 1
        page_text = page.get_text("text")

        pieces = _page_pieces(page_text, TARGET_CHARS)
        page_chunks = _chunk_pieces(pieces, TARGET_CHARS, OVERLAP_CHARS)

        for chunk_text in page_chunks:
            if len(chunk_text) < MIN_CHUNK_CHARS:
                continue
            chunks.append({"id": next_id, "page_no": page_no, "text": chunk_text})
            next_id += 1

        if on_page:
            on_page(page_no, doc.page_count)

    doc.close()
    return chunks


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("usage: python ingest.py <path.pdf>")
        sys.exit(1)

    result = ingest_pdf(sys.argv[1])
    print(f"chunks: {len(result)}")
    for chunk in result[:2]:
        print(f"--- page {chunk['page_no']} (id {chunk['id']}) ---")
        print(chunk["text"])

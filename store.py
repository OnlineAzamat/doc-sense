"""In-memory chunk + embedding store, singleton per process."""

import sys

import fitz
import numpy as np

from ingest import ingest_pdf
from llm import answer, embed, summarize_group

BROAD_SAMPLE_COUNT = 16
BROAD_CONTEXT_LIMIT = 12000
SUMMARY_GROUP_SIZE = 6

_chunks: list[dict] = []
_vectors: np.ndarray | None = None
_pdf_path: str | None = None
_page_count: int = 0


def _l2_normalize(matrix: np.ndarray) -> np.ndarray:
    norms = np.linalg.norm(matrix, axis=1, keepdims=True)
    norms[norms == 0] = 1.0
    return matrix / norms


async def load(pdf_path: str) -> None:
    global _chunks, _vectors, _pdf_path, _page_count

    chunks = ingest_pdf(pdf_path)
    texts = [c["text"] for c in chunks]
    raw_vectors = await embed(texts)

    matrix = _l2_normalize(np.array(raw_vectors, dtype=np.float32))

    with fitz.open(pdf_path) as doc:
        page_count = doc.page_count

    _chunks = chunks
    _vectors = matrix
    _pdf_path = pdf_path
    _page_count = page_count


def stats() -> dict:
    return {"pages": _page_count, "chunks": len(_chunks)}


def page_text(page_no: int) -> str:
    """All chunk text on one page — the fallback target when a quote won't locate."""
    return " ".join(c["text"] for c in _chunks if c["page_no"] == page_no)


def sample_for_summary() -> list[dict]:
    first = _chunks[:10]
    rest = _chunks[10:]
    if not rest:
        return first

    step = max(len(rest) // 5, 1)
    sampled = rest[::step][:5]
    return first + sampled


async def search(query: str, k: int = 4) -> list[dict]:
    if _vectors is None or not _chunks:
        return []

    query_vector = np.array((await embed([query]))[0], dtype=np.float32)
    norm = np.linalg.norm(query_vector)
    if norm > 0:
        query_vector = query_vector / norm

    scores = _vectors @ query_vector
    top_indices = np.argsort(-scores)[:k]

    hits = []
    for idx in top_indices:
        hit = dict(_chunks[idx])
        hit["score"] = float(scores[idx])
        hit["pages"] = [hit["page_no"]]
        hit["verbatim"] = True
        hits.append(hit)
    return hits


def _even_sample(count: int) -> list[dict]:
    """`count` chunks at even intervals across the whole document."""
    if len(_chunks) <= count:
        return list(_chunks)
    step = len(_chunks) / count
    return [_chunks[int(i * step)] for i in range(count)]


async def _summarize_in_groups(chunks: list[dict]) -> list[dict]:
    groups = [chunks[i : i + SUMMARY_GROUP_SIZE] for i in range(0, len(chunks), SUMMARY_GROUP_SIZE)]
    summaries = []

    for group in groups:
        pages = sorted({c["page_no"] for c in group})
        try:
            text = await summarize_group([c["text"] for c in group])
            verbatim = False
        except Exception as exc:
            # Never lose the group — fall back to its first chunk, which at least
            # stays verbatim and quotable.
            print(f"[store] group summary failed for pages {pages[0]}-{pages[-1]}, using raw chunk: {exc}")
            text = group[0]["text"]
            pages = [group[0]["page_no"]]
            verbatim = True

        summaries.append(
            {
                "id": f"group-{pages[0]}-{pages[-1]}",
                "page_no": pages[0],
                "pages": pages,
                "text": text,
                "verbatim": verbatim,
                "source_count": len(group),
            }
        )

    print(f"[store] broad context condensed into {len(summaries)} partial summaries")
    return summaries


async def retrieve(question: str, mode: str = "specific") -> list[dict]:
    hits = await search(question)
    if mode != "broad" or not _chunks:
        return hits

    combined = {c["id"]: c for c in hits}
    for chunk in _even_sample(BROAD_SAMPLE_COUNT):
        if chunk["id"] not in combined:
            combined[chunk["id"]] = dict(chunk, pages=[chunk["page_no"]], verbatim=True)

    ordered = sorted(combined.values(), key=lambda c: (c["page_no"], c["id"]))
    total_chars = sum(len(c["text"]) for c in ordered)
    print(f"[store] broad retrieval: {len(ordered)} chunks, {total_chars} chars")

    if total_chars <= BROAD_CONTEXT_LIMIT:
        return ordered
    return await _summarize_in_groups(ordered)


if __name__ == "__main__":
    import asyncio

    if len(sys.argv) < 3:
        print('usage: python store.py <path.pdf> "query" [specific|broad]')
        sys.exit(1)

    async def main():
        mode = sys.argv[3] if len(sys.argv) > 3 else "specific"
        await load(sys.argv[1])
        hits = await retrieve(sys.argv[2], mode)
        for hit in hits:
            print(f"pages={hit.get('pages')} verbatim={hit.get('verbatim')}")
            print(hit["text"][:200])
            print("---")

        result = await answer(sys.argv[2], hits, mode)
        print("=== answer() ===")
        print(result)

    asyncio.run(main())

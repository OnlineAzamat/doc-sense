"""In-memory chunk + embedding store, singleton per process."""

import sys

import numpy as np

from ingest import ingest_pdf
from llm import answer, embed

_chunks: list[dict] = []
_vectors: np.ndarray | None = None
_pdf_path: str | None = None


def _l2_normalize(matrix: np.ndarray) -> np.ndarray:
    norms = np.linalg.norm(matrix, axis=1, keepdims=True)
    norms[norms == 0] = 1.0
    return matrix / norms


async def load(pdf_path: str) -> None:
    global _chunks, _vectors, _pdf_path

    chunks = ingest_pdf(pdf_path)
    texts = [c["text"] for c in chunks]
    raw_vectors = await embed(texts)

    matrix = _l2_normalize(np.array(raw_vectors, dtype=np.float32))

    _chunks = chunks
    _vectors = matrix
    _pdf_path = pdf_path


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
        hits.append(hit)
    return hits


if __name__ == "__main__":
    import asyncio

    if len(sys.argv) != 3:
        print('usage: python store.py <path.pdf> "query"')
        sys.exit(1)

    async def main():
        await load(sys.argv[1])
        hits = await search(sys.argv[2])
        for hit in hits:
            print(f"score={hit['score']:.4f} page={hit['page_no']}")
            print(hit["text"][:200])
            print("---")

        result = await answer(sys.argv[2], hits)
        print("=== answer() ===")
        print(result)

    asyncio.run(main())

"""Disk cache for parsed chunks + embeddings, keyed by the PDF's content hash.

Not a database — one .json and one .npy per document. Every failure path here
is a cache miss, which just means the normal load runs.
"""

import hashlib
import json
import os

import numpy as np

CACHE_DIR = "cache"
CACHE_VERSION = 1

os.makedirs(CACHE_DIR, exist_ok=True)


def key_for(pdf_path: str) -> str:
    """Hash the bytes, not the filename — a renamed copy is the same document."""
    digest = hashlib.sha256()
    with open(pdf_path, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def _paths(key: str) -> tuple[str, str]:
    return (
        os.path.join(CACHE_DIR, f"{key}.json"),
        os.path.join(CACHE_DIR, f"{key}.npy"),
    )


def load(key: str, fingerprint: dict) -> dict | None:
    """Cached chunks + vectors, or None on any doubt whatsoever."""
    meta_path, vectors_path = _paths(key)
    if not (os.path.exists(meta_path) and os.path.exists(vectors_path)):
        return None

    try:
        with open(meta_path, encoding="utf-8") as f:
            meta = json.load(f)

        if meta.get("version") != CACHE_VERSION or meta.get("fingerprint") != fingerprint:
            print(f"[cache] {key[:8]} ignored: built by a different embedding pipeline")
            return None

        vectors = np.load(vectors_path)
        chunks = meta["chunks"]
        if len(chunks) != len(vectors):
            print(f"[cache] {key[:8]} ignored: {len(chunks)} chunks but {len(vectors)} vectors")
            return None
    except Exception as exc:
        print(f"[cache] {key[:8]} unreadable, re-embedding: {exc}")
        return None

    return {"chunks": chunks, "vectors": vectors, "page_count": meta["page_count"]}


def save(key: str, fingerprint: dict, chunks: list[dict], vectors: np.ndarray, page_count: int) -> None:
    """Best effort. A failed cache write must never fail the upload."""
    meta_path, vectors_path = _paths(key)
    try:
        # Vectors first: the meta file is what `load` looks for, so a half
        # finished write reads back as a plain miss.
        np.save(vectors_path, vectors)
        with open(meta_path, "w", encoding="utf-8") as f:
            json.dump(
                {
                    "version": CACHE_VERSION,
                    "fingerprint": fingerprint,
                    "page_count": page_count,
                    "chunks": chunks,
                },
                f,
                ensure_ascii=False,
            )
        print(f"[cache] stored {key[:8]}: {len(chunks)} chunks")
    except Exception as exc:
        print(f"[cache] could not store {key[:8]}: {exc}")

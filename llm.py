"""Ollama calls: embeddings and chat."""

import json

import httpx

import prompts

OLLAMA_URL = "http://localhost:11434"
EMBED_MODEL = "bge-m3"
EMBED_BATCH_SIZE = 32
CHAT_MODEL = "qwen3.6:27b"
GROUP_SUMMARY_MODEL = "qwen3:32b"
MAX_SOURCES = 5

_client = httpx.AsyncClient(timeout=120.0)


async def embed(texts: list[str], on_batch=None) -> list[list[float]]:
    """on_batch(done, total) fires after each batch, for progress reporting."""
    vectors: list[list[float]] = []

    for i in range(0, len(texts), EMBED_BATCH_SIZE):
        batch = texts[i : i + EMBED_BATCH_SIZE]
        try:
            response = await _client.post(
                f"{OLLAMA_URL}/api/embed",
                json={"model": EMBED_MODEL, "input": batch},
            )
            response.raise_for_status()
        except httpx.HTTPError as exc:
            print(f"[llm] Ollama embed call failed (is `ollama serve` running with bge-m3 pulled?): {exc}")
            raise

        vectors.extend(response.json()["embeddings"])
        if on_batch:
            on_batch(len(vectors), len(texts))

    return vectors


def _excerpt_label(chunk: dict) -> str:
    pages = chunk.get("pages") or [chunk["page_no"]]
    if len(pages) == 1:
        return f"page {pages[0]}"
    return f"pages {pages[0]}-{pages[-1]}, SUMMARY"


def allowed_pages(chunks: list[dict]) -> set[int]:
    pages: set[int] = set()
    for chunk in chunks:
        pages.update(chunk.get("pages") or [chunk["page_no"]])
    return pages


def _build_user_message(question: str, chunks: list[dict], mode: str) -> str:
    excerpts = "\n\n".join(
        f"[{i + 1}] ({_excerpt_label(chunk)}) {chunk['text']}"
        for i, chunk in enumerate(chunks)
    )
    parts = [f"Excerpts:\n{excerpts}"]
    if any(not chunk.get("verbatim", True) for chunk in chunks):
        parts.append(prompts.SUMMARY_EXCERPT_NOTE)
    parts.append(prompts.MODE_HINT.get(mode, prompts.MODE_HINT["specific"]))
    parts.append(f"Question: {question}")
    return "\n\n".join(parts)


_RAW_BREAKS = {"\n": "\\n", "\r": "\\r", "\t": "\\t"}


def _escape_raw_newlines(text: str) -> str:
    """A Markdown answer tempts the model into real line breaks inside the JSON
    string. Escaping them here saves a whole retry call mid-demo."""
    out: list[str] = []
    in_string = False
    escaped = False
    for ch in text:
        if in_string and not escaped and ch in _RAW_BREAKS:
            out.append(_RAW_BREAKS[ch])
            continue
        if escaped:
            escaped = False
        elif ch == "\\":
            escaped = True
        elif ch == '"':
            in_string = not in_string
        out.append(ch)
    return "".join(out)


def _extract_json(raw: str) -> dict | None:
    text = raw.strip()
    if text.startswith("```"):
        text = text.strip("`")
        if text.startswith("json"):
            text = text[4:]

    start = text.find("{")
    end = text.rfind("}")
    if start == -1 or end == -1 or end < start:
        return None

    candidate = text[start : end + 1]
    try:
        data = json.loads(candidate)
    except json.JSONDecodeError:
        try:
            data = json.loads(_escape_raw_newlines(candidate))
        except json.JSONDecodeError:
            return None

    return data if isinstance(data, dict) else None


def _parse_answer(raw: str) -> dict | None:
    data = _extract_json(raw)
    if data is None or not {"answer", "scope", "sources"} <= data.keys():
        return None
    return data


def _clean_answer(data: dict, pages: set[int]) -> dict:
    scope = data.get("scope")
    if scope not in ("specific", "broad", "not_found"):
        scope = "specific"

    sources: list[dict] = []
    seen: set[tuple[int, str]] = set()
    raw_sources = data.get("sources")
    for item in raw_sources if isinstance(raw_sources, list) else []:
        if not isinstance(item, dict):
            continue
        try:
            page_no = int(item["page_no"])
        except (KeyError, TypeError, ValueError):
            continue
        quote = item.get("quote")
        if not isinstance(quote, str) or not quote.strip():
            continue
        if page_no not in pages:
            print(f"[llm] dropped source: page {page_no} was not in the retrieved context")
            continue
        key = (page_no, quote.strip())
        if key in seen:
            continue
        seen.add(key)
        sources.append({"page_no": page_no, "quote": quote.strip()})
        if len(sources) == MAX_SOURCES:
            break

    answer_text = data.get("answer")
    return {
        "answer": answer_text if isinstance(answer_text, str) else "",
        "scope": scope,
        "sources": [] if scope == "not_found" else sources,
    }


def _parse_summary(raw: str) -> dict | None:
    data = _extract_json(raw)
    if data is None or not {"title", "summary", "topics"} <= data.keys():
        return None
    return data


async def _chat(messages: list[dict], model: str = CHAT_MODEL) -> str:
    try:
        response = await _client.post(
            f"{OLLAMA_URL}/api/chat",
            json={"model": model, "messages": messages, "stream": False},
        )
        response.raise_for_status()
    except httpx.HTTPError as exc:
        print(f"[llm] Ollama chat call failed (is `ollama serve` running with {model} pulled?): {exc}")
        raise
    return response.json()["message"]["content"]


async def answer(question: str, chunks: list[dict], mode: str = "specific") -> dict:
    messages = [
        {"role": "system", "content": prompts.SYSTEM_PROMPT},
        {"role": "user", "content": _build_user_message(question, chunks, mode)},
    ]
    pages = allowed_pages(chunks)

    raw = await _chat(messages)
    parsed = _parse_answer(raw)
    if parsed is not None:
        return _clean_answer(parsed, pages)

    messages.append({"role": "assistant", "content": raw})
    messages.append({"role": "user", "content": prompts.STRICT_REMINDER})
    raw_retry = await _chat(messages)
    parsed_retry = _parse_answer(raw_retry)
    if parsed_retry is not None:
        return _clean_answer(parsed_retry, pages)

    print("[llm] answer JSON still unparseable after retry")
    return {"answer": "", "scope": "not_found", "sources": []}


async def summarize_group(texts: list[str]) -> str:
    """Condense a group of chunks into one paragraph, for broad-question context."""
    excerpts = "\n\n".join(f"[{i + 1}] {text}" for i, text in enumerate(texts))
    messages = [
        {"role": "system", "content": prompts.GROUP_SUMMARY_SYSTEM_PROMPT},
        {"role": "user", "content": f"Excerpts:\n{excerpts}"},
    ]
    return (await _chat(messages, model=GROUP_SUMMARY_MODEL)).strip()


def _build_summary_message(chunks: list[dict]) -> str:
    excerpts = "\n\n".join(f"[{i + 1}] {chunk['text']}" for i, chunk in enumerate(chunks))
    return f"Excerpts:\n{excerpts}"


async def summarize_document(chunks: list[dict]) -> dict:
    messages = [
        {"role": "system", "content": prompts.SUMMARY_SYSTEM_PROMPT},
        {"role": "user", "content": _build_summary_message(chunks)},
    ]

    raw = await _chat(messages)
    parsed = _parse_summary(raw)
    if parsed is not None:
        return parsed

    messages.append({"role": "assistant", "content": raw})
    messages.append({"role": "user", "content": prompts.STRICT_REMINDER})
    raw_retry = await _chat(messages)
    parsed_retry = _parse_summary(raw_retry)
    if parsed_retry is not None:
        return parsed_retry

    return {"title": "", "summary": "", "topics": []}

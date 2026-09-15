"""Ollama calls: embeddings and chat."""

import json

import httpx

OLLAMA_URL = "http://localhost:11434"
EMBED_MODEL = "bge-m3"
EMBED_BATCH_SIZE = 32
CHAT_MODEL = "qwen3.6:27b"

_client = httpx.AsyncClient(timeout=120.0)

_SYSTEM_PROMPT = (
    "You are DocSense, a document Q&A assistant. Answer strictly using the "
    "numbered excerpts the user provides — never use outside knowledge. "
    "Answer in the same language as the question. If the excerpts do not "
    "contain the answer, say so plainly instead of guessing.\n\n"
    "Respond with ONLY a JSON object. No markdown code fences, no preamble, "
    "no explanation before or after it. It must have exactly these keys:\n"
    '{"answer": str, "page_no": int, "quote": str, "found": bool}\n\n'
    '"quote" must be copied verbatim, word-for-word, from one of the '
    "excerpts, 5 to 25 words long, and must be the single passage that best "
    'supports the answer. "page_no" must be the page number of the excerpt '
    'that quote came from. If the excerpts do not contain the answer, set '
    '"found" to false and leave "quote" empty.'
)

_STRICT_REMINDER = (
    "Your previous reply was not valid JSON. Reply again with ONLY the JSON "
    "object described above — no markdown fences, no extra text."
)


async def embed(texts: list[str]) -> list[list[float]]:
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

    return vectors


def _build_user_message(question: str, chunks: list[dict]) -> str:
    excerpts = "\n\n".join(
        f"[{i + 1}] (page {chunk['page_no']}) {chunk['text']}"
        for i, chunk in enumerate(chunks)
    )
    return f"Excerpts:\n{excerpts}\n\nQuestion: {question}"


def _parse_answer(raw: str) -> dict | None:
    text = raw.strip()
    if text.startswith("```"):
        text = text.strip("`")
        if text.startswith("json"):
            text = text[4:]

    start = text.find("{")
    end = text.rfind("}")
    if start == -1 or end == -1 or end < start:
        return None

    try:
        data = json.loads(text[start : end + 1])
    except json.JSONDecodeError:
        return None

    if not isinstance(data, dict) or not {"answer", "page_no", "quote", "found"} <= data.keys():
        return None

    return data


async def _chat(messages: list[dict]) -> str:
    try:
        response = await _client.post(
            f"{OLLAMA_URL}/api/chat",
            json={"model": CHAT_MODEL, "messages": messages, "stream": False},
        )
        response.raise_for_status()
    except httpx.HTTPError as exc:
        print(f"[llm] Ollama chat call failed (is `ollama serve` running with {CHAT_MODEL} pulled?): {exc}")
        raise
    return response.json()["message"]["content"]


async def answer(question: str, chunks: list[dict]) -> dict:
    messages = [
        {"role": "system", "content": _SYSTEM_PROMPT},
        {"role": "user", "content": _build_user_message(question, chunks)},
    ]

    raw = await _chat(messages)
    parsed = _parse_answer(raw)
    if parsed is not None:
        return parsed

    messages.append({"role": "assistant", "content": raw})
    messages.append({"role": "user", "content": _STRICT_REMINDER})
    raw_retry = await _chat(messages)
    parsed_retry = _parse_answer(raw_retry)
    if parsed_retry is not None:
        return parsed_retry

    return {"found": False}

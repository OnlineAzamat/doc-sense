"""Query-type routing: is this question about one passage, or the whole document?"""

import re

import httpx

OLLAMA_URL = "http://localhost:11434"
ROUTER_MODEL = "qwen3:4b"

_client = httpx.AsyncClient(timeout=20.0)

# Uzbek, Russian and English stems that signal a whole-document question.
# Matched as substrings, which is what we want for inflected Uzbek/Russian.
_BROAD_KEYWORDS = [
    # Uzbek
    "xulosa", "qisqacha", "qisqartir", "umumiy", "umuman", "umumlashtir",
    "nima haqida", "nimalar haqida", "asosiy g'oya", "asosiy fikr",
    "asosiy mavzu", "asosiy nuqta", "asosiy jihat", "bosh mavzu",
    "butun hujjat", "hujjat nima", "mazmuni nima", "sanab bering",
    # Russian
    "кратк", "вкратце", "резюм", "обобщ", "суммир", "в целом",
    "обзор документ", "содержание документ", "о чем документ", "о чем эта",
    "о чем этот", "о чем текст", "основная мысл", "основные иде",
    "основные тем", "основные момент", "основные положен", "главная мысл",
    "главные иде", "ключевые момент", "ключевые иде", "ключевые тезис",
    # English
    "summar", "overview", "what is this about", "what's this about",
    "what is the document about", "main idea", "main topic", "main point",
    "key point", "key take", "key idea", "gist", "tldr", "tl;dr",
    "outline", "high level", "high-level", "overall",
]

_ROUTER_SYSTEM = (
    "Classify a question about a document as specific (about one fact, passage "
    "or detail) or broad (about the document as a whole: summary, overview, "
    "main ideas, key points).\n"
    "Reply with exactly one word: specific or broad."
)

_APOSTROPHES = re.compile("[‘’ʻʼ`´]")


def _normalize(question: str) -> str:
    text = _APOSTROPHES.sub("'", question.lower())
    # Russian ё/е are typed interchangeably ("о чём" vs "о чем").
    return text.replace("ё", "е")


def _keyword_match(question: str) -> str | None:
    text = _normalize(question)
    for keyword in _BROAD_KEYWORDS:
        if keyword in text:
            return keyword
    return None


async def _ask_model(question: str) -> str | None:
    try:
        response = await _client.post(
            f"{OLLAMA_URL}/api/chat",
            json={
                "model": ROUTER_MODEL,
                "messages": [
                    {"role": "system", "content": _ROUTER_SYSTEM},
                    {"role": "user", "content": question},
                ],
                "stream": False,
                "think": False,
            },
        )
        response.raise_for_status()
    except httpx.HTTPError as exc:
        print(f"[router] Ollama call failed (is `ollama serve` running with {ROUTER_MODEL} pulled?): {exc}")
        return None

    try:
        reply = response.json()["message"]["content"].strip().lower()
    except (KeyError, ValueError) as exc:
        print(f"[router] unreadable reply from {ROUTER_MODEL}: {exc}")
        return None

    if "broad" in reply:
        return "broad"
    if "specific" in reply:
        return "specific"
    print(f"[router] {ROUTER_MODEL} returned neither word: {reply[:60]!r}")
    return None


async def classify(question: str) -> str:
    keyword = _keyword_match(question)
    if keyword:
        print(f"[router] broad (keyword {keyword!r}) <- {question[:60]!r}")
        return "broad"

    mode = await _ask_model(question)
    if mode is None:
        print(f"[router] specific (default after model failure) <- {question[:60]!r}")
        return "specific"

    print(f"[router] {mode} ({ROUTER_MODEL}) <- {question[:60]!r}")
    return mode

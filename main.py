"""FastAPI app, routes only."""

import asyncio
import json
import os
import time

from fastapi import FastAPI, HTTPException, UploadFile
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

import highlight
import router
import store
from llm import answer, summarize_document

UPLOAD_DIR = "uploads"
GENERIC_ERROR = "Qayta urinib ko'ring."
EMPTY_SUMMARY = {"title": "", "summary": "", "topics": []}

os.makedirs(UPLOAD_DIR, exist_ok=True)

app = FastAPI()

_current_pdf_path: str | None = None
_summary_cache: dict[str, dict] = {}


class AskRequest(BaseModel):
    question: str


@app.get("/health")
def health():
    return {"ok": True}


def _sse(event: str, data: dict) -> str:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


async def _upload_stream(dest_path: str, safe_name: str):
    """Run the load in the background, relaying its progress as SSE."""
    queue: asyncio.Queue = asyncio.Queue()
    loop = asyncio.get_running_loop()
    started = time.perf_counter()

    def emit(event: str, data: dict) -> None:
        # Called from the ingest worker thread as well as the event loop.
        loop.call_soon_threadsafe(queue.put_nowait, (event, data))

    async def run() -> None:
        global _current_pdf_path
        try:
            await store.load(dest_path, emit)
        except Exception as exc:
            print(f"[main] failed to load PDF {safe_name}: {exc}")
            emit("error", {"message": GENERIC_ERROR})
            return
        _current_pdf_path = dest_path
        counts = store.stats()
        emit("done", {**counts, "seconds": round(time.perf_counter() - started, 1)})

    task = asyncio.create_task(run())
    try:
        while True:
            event, data = await queue.get()
            yield _sse(event, data)
            if event in ("done", "error"):
                return
    finally:
        if not task.done():
            task.cancel()


@app.post("/upload")
async def upload(file: UploadFile):
    if not file.filename.lower().endswith(".pdf"):
        raise HTTPException(status_code=400, detail=GENERIC_ERROR)

    safe_name = os.path.basename(file.filename)
    dest_path = os.path.join(UPLOAD_DIR, safe_name)
    contents = await file.read()
    with open(dest_path, "wb") as f:
        f.write(contents)

    return StreamingResponse(
        _upload_stream(dest_path, safe_name),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.get("/summary")
async def get_summary():
    """Fetched after the upload stream closes, so the loader never waits on the LLM."""
    if _current_pdf_path is None:
        raise HTTPException(status_code=400, detail=GENERIC_ERROR)

    safe_name = os.path.basename(_current_pdf_path)
    if safe_name not in _summary_cache:
        try:
            _summary_cache[safe_name] = await summarize_document(store.sample_for_summary())
        except Exception as exc:
            print(f"[main] summary generation failed for {safe_name}: {exc}")
            _summary_cache[safe_name] = EMPTY_SUMMARY

    return _summary_cache[safe_name]


@app.get("/pdf")
def get_pdf():
    if _current_pdf_path is None:
        raise HTTPException(status_code=404, detail=GENERIC_ERROR)
    return FileResponse(_current_pdf_path, media_type="application/pdf")


def _analyzed(chunks: list[dict]) -> dict:
    pages = set()
    sections = 0
    for chunk in chunks:
        pages.update(chunk.get("pages") or [chunk["page_no"]])
        # a summarized group stands in for several chunks
        sections += chunk.get("source_count", 1)
    return {"pages": len(pages), "sections": sections}


def _locate_sources(sources: list[dict]) -> list[dict]:
    """find_rects every source. Drop the ones that miss, unless nothing else landed."""
    located, misses = [], []

    for source in sources:
        page_no = source["page_no"]
        try:
            rect_data = highlight.find_rects(
                _current_pdf_path, page_no, source["quote"], store.page_text(page_no)
            )
        except Exception as exc:
            print(f"[main] highlight failed on page {page_no}: {exc}")
            continue

        entry = {
            "page_no": page_no,
            "quote": source["quote"],
            "rects": rect_data["rects"],
            "page_width": rect_data["page_width"],
            "page_height": rect_data["page_height"],
        }
        (located if rect_data["ok"] else misses).append(entry)

    # Never return zero highlights: if every quote missed, keep the first
    # whole-page fallback rather than showing the answer bare.
    return located or misses[:1]


@app.post("/ask")
async def ask(payload: AskRequest):
    if _current_pdf_path is None:
        raise HTTPException(status_code=400, detail=GENERIC_ERROR)

    try:
        mode = await router.classify(payload.question)
        hits = await store.retrieve(payload.question, mode)
        result = await answer(payload.question, hits, mode)
    except Exception as exc:
        print(f"[main] ask pipeline failed: {exc}")
        raise HTTPException(status_code=500, detail=GENERIC_ERROR)

    scores = [hit["score"] for hit in hits if isinstance(hit.get("score"), float)]
    top_score = max(scores) if scores else None

    try:
        sources = _locate_sources(result["sources"])
    except Exception as exc:
        print(f"[main] highlight pipeline failed: {exc}")
        raise HTTPException(status_code=500, detail=GENERIC_ERROR)

    return {
        "answer": result["answer"],
        "scope": result["scope"],
        "sources": sources,
        "analyzed": _analyzed(hits),
        "top_score": top_score,
    }


app.mount("/", StaticFiles(directory="static", html=True), name="static")

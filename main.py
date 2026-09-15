"""FastAPI app, routes only."""

import os

from fastapi import FastAPI, HTTPException, UploadFile
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

import highlight
import store
from llm import answer

UPLOAD_DIR = "uploads"
GENERIC_ERROR = "Qayta urinib ko'ring."

os.makedirs(UPLOAD_DIR, exist_ok=True)

app = FastAPI()

_current_pdf_path: str | None = None


class AskRequest(BaseModel):
    question: str


@app.get("/health")
def health():
    return {"ok": True}


@app.post("/upload")
async def upload(file: UploadFile):
    global _current_pdf_path

    if not file.filename.lower().endswith(".pdf"):
        raise HTTPException(status_code=400, detail=GENERIC_ERROR)

    safe_name = os.path.basename(file.filename)
    dest_path = os.path.join(UPLOAD_DIR, safe_name)
    contents = await file.read()
    with open(dest_path, "wb") as f:
        f.write(contents)

    try:
        await store.load(dest_path)
    except Exception as exc:
        print(f"[main] failed to load PDF {safe_name}: {exc}")
        raise HTTPException(status_code=500, detail=GENERIC_ERROR)

    _current_pdf_path = dest_path
    counts = store.stats()
    return {"filename": safe_name, "pages": counts["pages"], "chunks": counts["chunks"]}


@app.get("/pdf")
def get_pdf():
    if _current_pdf_path is None:
        raise HTTPException(status_code=404, detail=GENERIC_ERROR)
    return FileResponse(_current_pdf_path, media_type="application/pdf")


@app.post("/ask")
async def ask(payload: AskRequest):
    if _current_pdf_path is None:
        raise HTTPException(status_code=400, detail=GENERIC_ERROR)

    try:
        hits = await store.search(payload.question)
        result = await answer(payload.question, hits)
    except Exception as exc:
        print(f"[main] ask pipeline failed: {exc}")
        raise HTTPException(status_code=500, detail=GENERIC_ERROR)

    if not result.get("found"):
        return {
            "answer": result.get("answer", ""),
            "page_no": None,
            "rects": [],
            "page_width": None,
            "page_height": None,
            "found": False,
        }

    page_no = result["page_no"]
    chunk_text = next(
        (hit["text"] for hit in hits if hit["page_no"] == page_no),
        hits[0]["text"] if hits else "",
    )

    try:
        rect_data = highlight.find_rects(_current_pdf_path, page_no, result["quote"], chunk_text)
    except Exception as exc:
        print(f"[main] highlight failed: {exc}")
        raise HTTPException(status_code=500, detail=GENERIC_ERROR)

    return {
        "answer": result["answer"],
        "page_no": page_no,
        "rects": rect_data["rects"],
        "page_width": rect_data["page_width"],
        "page_height": rect_data["page_height"],
        "found": True,
    }


app.mount("/", StaticFiles(directory="static", html=True), name="static")

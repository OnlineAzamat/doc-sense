# DocSense — local document Q&A demo

## What this is
A demo app for a non-technical audience. A user uploads a PDF, asks questions in
natural language, and gets an answer **with the exact source passage highlighted
inside the PDF viewer**. The highlight is the whole point of the demo — never
degrade it to plain text answers.

Everything runs locally. No cloud APIs. No API keys anywhere in the code.

## Audience & priorities
This is presentation software, not production software.

Priority order:
1. It must not crash during a live demo.
2. The highlight must land on the right passage.
3. It must look like a finished product (dark UI, animations, branding).
4. Code quality / test coverage — last. Do not write tests unless asked.

## Stack (do not substitute without asking)
- Python 3.11, FastAPI, uvicorn
- PDF parsing: PyMuPDF (`fitz`)
- Embeddings: `bge-m3` via Ollama (`http://localhost:11434/api/embed`)
- LLM: `qwen3:32b` via Ollama (`/api/chat`), streaming enabled
- Vector search: plain numpy cosine similarity, in memory. No FAISS, no Qdrant,
  no Chroma. The corpus is one document.
- Frontend: single `index.html` + `app.js` + `style.css`, served by FastAPI.
  PDF.js from CDN. No React, no build step, no npm.

## Languages
Documents and questions will be in Uzbek and Russian, occasionally English.
Always instruct the LLM to answer in the same language as the question.
Never translate the source quote — it must match the PDF byte for byte.

## Layout
```
docsense/
  main.py            # FastAPI app, routes only
  ingest.py          # PDF -> pages -> chunks with page numbers
  store.py           # embeddings + cosine search, in-memory singleton
  llm.py             # Ollama calls (embed + chat)
  highlight.py       # quote -> PyMuPDF rects
  static/
    index.html
    app.js
    style.css
  uploads/           # gitignored
```

## The highlight mechanism — read this before touching it
1. `ingest.py` splits the PDF into chunks and records `page_no` for each chunk.
2. The LLM is forced to return JSON containing a `quote` field: a verbatim
   substring of the retrieved chunk, 5–25 words long.
3. `highlight.py` calls `page.search_for(quote)` on that page and returns the
   rectangles in PDF coordinate space, plus the page width/height.
4. The frontend scales those rects to the rendered canvas size and draws
   translucent overlays.

If `search_for` returns nothing, retry with the first 8 words of the quote, then
the first 5. If still nothing, highlight the whole chunk's bounding box rather
than returning no highlight at all.

## UI rules
- Dark theme. Background `#0B0E14`, panels `#151A23`, accent `#4F8CFF`,
  highlight overlay `rgba(255, 214, 0, 0.35)`.
- Two-column layout: PDF viewer left (60%), chat right (40%).
- Product name "DocSense" top-left, version badge `v0.9 beta` next to it.
- While waiting for the model, show staged status text that advances every
  ~600ms: "Hujjat indekslanmoqda" -> "Tegishli bo'limlar qidirilmoqda" ->
  "Javob tayyorlanmoqda". Never show a bare spinner.
- Stream the answer token by token.
- Never surface stack traces, JSON, or log output in the UI. On any error show:
  "Qayta urinib ko'ring."

## Ollama
Assume Ollama is already running with `qwen3:26b` and `bge-m3` pulled. If a call
fails, print a one-line hint to the server console and return a clean error to
the client. Do not add fallback models silently.

## Working style
- One stage at a time. After each stage, tell me exactly how to verify it and
  stop.
- Prefer boring, obvious code. No abstractions with one implementation.
- Keep every file under ~200 lines.
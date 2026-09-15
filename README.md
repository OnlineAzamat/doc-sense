# DocSense

**DocSense** is a local, offline document Q&A demo. Upload a PDF, ask questions
about it in natural language, and get an answer with the **exact source
passage highlighted inside the PDF viewer**.

Everything runs on your machine — no cloud APIs, no API keys.

![status](https://img.shields.io/badge/status-demo-blue) ![python](https://img.shields.io/badge/python-3.11-blue) ![license](https://img.shields.io/badge/license-MIT-lightgrey)

## How it works

1. The PDF is split into pages, then into overlapping text chunks
   (`ingest.py`).
2. Each chunk is embedded with `bge-m3` (via Ollama) and stored in memory as a
   numpy array — no vector database, since the corpus is a single document
   (`store.py`).
3. A question is embedded and compared against chunks with cosine similarity
   to retrieve the most relevant ones.
4. `qwen3.6:27b` (via Ollama) is prompted to answer using only the retrieved
   context, streaming the response, and returning a JSON payload with a
   verbatim `quote` (5–25 words) taken directly from the source (`llm.py`).
5. `highlight.py` locates that quote on the PDF page with PyMuPDF
   (`page.search_for`) and returns its rectangles in PDF coordinate space. If
   the exact quote can't be found, it retries with a shorter prefix, then
   falls back to highlighting the whole chunk's bounding box.
6. The frontend (plain HTML/CSS/JS + PDF.js, no build step) renders the PDF on
   a canvas and draws the highlight overlay on top, scaled to match.

The source quote is never translated or paraphrased — it must match the PDF
text byte for byte so the highlight lands correctly.

## Stack

- **Backend:** Python 3.11, FastAPI, uvicorn
- **PDF parsing:** PyMuPDF (`fitz`)
- **Embeddings:** `bge-m3` via [Ollama](https://ollama.com)
- **LLM:** `qwen3.6:27b` via Ollama, streaming
- **Vector search:** plain numpy cosine similarity, in memory
- **Frontend:** static `index.html` + `app.js` + `style.css`, served by
  FastAPI; [PDF.js](https://mozilla.github.io/pdf.js/) from CDN — no React, no
  npm, no build step

## Languages

Built for documents and questions in **Uzbek** and **Russian**, with
occasional English. The model always answers in the same language as the
question, while the highlighted source quote stays in the document's original
language.

## Prerequisites

- Python 3.11+
- [Ollama](https://ollama.com) installed and running locally, with the
  required models pulled:

  ```bash
  ollama pull bge-m3
  ollama pull qwen3.6:27b
  ```

## Setup

```bash
# clone the repo
git clone https://github.com/<your-username>/aidoc.git
cd aidoc

# create a virtual environment
python -m venv venv
venv\Scripts\activate        # Windows
# source venv/bin/activate   # macOS / Linux

# install dependencies
pip install -r requirements.txt
```

## Running

Make sure Ollama is running in the background, then start the app:

```bash
uvicorn main:app --reload
```

Open [http://localhost:8000](http://localhost:8000) in your browser, upload a
PDF, and start asking questions.

## Project layout

```
docsense/
  main.py            # FastAPI app, routes only
  ingest.py           # PDF -> pages -> chunks with page numbers
  store.py             # embeddings + cosine search, in-memory singleton
  llm.py                # Ollama calls (embed + chat)
  highlight.py           # quote -> PyMuPDF rects
  static/
    index.html
    app.js
    style.css
  uploads/               # uploaded PDFs (gitignored)
```

## Notes

This is a presentation/demo project, not production software:

- The document store is a single in-memory instance — one document at a time,
  no persistence between restarts.
- There is no authentication, and uploaded files are kept locally in
  `uploads/`.
- No fallback models are used; if Ollama or a model call fails, the UI shows a
  generic retry message instead of technical error details.

## License

[MIT](LICENSE)

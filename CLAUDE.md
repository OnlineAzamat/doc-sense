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
- LLM: `qwen3.6:27b` via Ollama (`/api/chat`), streaming enabled
- Query router: `qwen3:4b` via Ollama, one word out. Defaults to `specific` on
  any failure, so the demo survives the model not being pulled.
- Broad-context condensing: `qwen3:32b` via Ollama. If a group call fails the
  group falls back to its own first chunk verbatim — never to another model.
- Vector search: plain numpy cosine similarity, in memory. No FAISS, no Qdrant,
  no Chroma. The corpus is one document.
- Frontend: `index.html` + `app.js` + `loader.js` + `hero.js` + `markdown.js` +
  `style.css`, served by
  FastAPI. PDF.js from CDN. No React, no build step, no npm.

## Languages
Documents and questions will be in Uzbek and Russian, occasionally English.
Always instruct the LLM to answer in the same language as the question.
Never translate the source quote — it must match the PDF byte for byte.

## Layout
```
docsense/
  main.py            # FastAPI app, routes only
  ingest.py          # PDF -> pages -> chunks with page numbers
  router.py          # question -> "specific" | "broad"
  cache.py           # disk cache of chunks + vectors, keyed by PDF content hash
  store.py           # embeddings + cosine search + retrieval, in-memory singleton
  llm.py             # Ollama calls (embed + chat)
  prompts.py         # prompt text for llm.py, strings only
  highlight.py       # quote -> PyMuPDF rects
  static/
    index.html
    app.js
    loader.js        # canvas upload-analysis animation
    hero.js          # looping mini-demo inside the empty dropzone
    markdown.js      # tiny Markdown -> HTML renderer for answers
    style.css
  cache/             # gitignored
  uploads/           # gitignored
```

## Embedding cache
Re-uploading a document must not re-run the embedding pass. `cache.py` keeps
`cache/<sha256>.json` (chunks + meta) and `cache/<sha256>.npy` (the normalized
vectors) per document. Deliberately not a database — the corpus is one document
and a miss is always safe.

- The key is the sha256 of the **file bytes**, so a renamed copy still hits.
- The meta file carries a fingerprint: embed model plus the three `ingest.py`
  chunking constants. Change any of them and the entry is ignored, never
  reused — a stale vector would quietly ruin retrieval.
- Every failure — unreadable JSON, a chunk/vector count mismatch, a failed
  write — is a cache miss and a one-line console note. It never raises.
- `store.load` returns True on a hit and replays `meta` + both `progress`
  events so the loader animation still builds its grid and its cloud; the
  2.5s stretch covers the rest. `done` carries `cached`, and the stats strip
  appends "· keshdan".
- Vectors are written before the meta file, so a half-finished write reads back
  as a miss rather than as corrupt state.

## Query routing
`router.classify(question)` returns `"specific"` or `"broad"`:
1. A keyword heuristic first — Uzbek, Russian and English stems for summarize /
   overview / what is this about / main ideas / key points. Substring matching,
   which is what inflected Uzbek and Russian need. Apostrophe variants and
   Russian ё/е are normalized first.
2. No match -> one `qwen3:4b` call with a 2-line prompt returning one word.
3. Any failure -> `specific`. Every decision is logged to the console.

## Retrieval
`store.retrieve(question, mode)`:
- `specific`: top 4 by cosine. Unchanged.
- `broad`: top 4 by cosine PLUS 16 chunks sampled at even intervals across the
  whole chunk list, deduplicated by chunk id, sorted by page number.
  If the combined text exceeds ~12000 characters, the chunks are condensed in
  groups of 6 by `qwen3:32b` first and those partial summaries become the
  context.

A chunk carries `pages` (a list — one entry normally, the whole range for a
group summary), `verbatim` (false for group summaries) and `source_count`.
Group summaries are labelled SUMMARY in the prompt so the model prefers quoting
verbatim excerpts.

## The answer contract — read this before touching it
The LLM is forced to return JSON:
```json
{
  "answer": "str",
  "scope": "specific | broad | not_found",
  "sources": [{"page_no": 0, "quote": "str"}]
}
```
- `specific`: 1-2 sources, each quote verbatim, 5-25 words.
- `broad`: 3-5 sources from DIFFERENT pages spread across the document. Quotes
  still verbatim.
- `not_found`: empty `sources`, and the answer states plainly that the document
  does not cover it. Never fall back to general knowledge.

`answer` may carry light Markdown — bold, `-`/`1.` lists, `|` tables, `###`
headings — when the answer has structure; a short factual answer stays plain
prose. Markdown never appears in a `quote`: the quote must stay byte-identical
to the PDF or the highlight misses. `_extract_json` repairs raw line breaks
inside the JSON string rather than paying for a retry call.

`llm._clean_answer` caps sources at 5, deduplicates them, and drops any source
whose `page_no` was not in the retrieved context. Never let an invented page
number reach the frontend.

## The highlight mechanism — read this before touching it
1. `ingest.py` splits the PDF into chunks and records `page_no` for each chunk.
2. `main.py` runs `highlight.find_rects` for **every** source, not just one.
3. `highlight.py` calls `page.search_for(quote)` on that page and returns the
   rectangles in PDF coordinate space, plus the page width/height and an `ok`
   flag saying whether a real match was found.
4. `/ask` returns a `sources` array; each entry has `page_no`, `quote`, `rects`,
   `page_width`, `page_height`.
5. The frontend scales those rects to the rendered canvas size and draws
   translucent overlays.

If `search_for` returns nothing, retry with the first 8 words of the quote, then
the first 5, then the chunk's own opening words. If still nothing, `ok` is false
and the whole page rect is returned.

A source whose quote could not be located is dropped silently and the others are
kept — unless every source missed, in which case the first fallback is kept, so
an answer is never shown with no highlight at all.

## Upload progress
`/upload` is a POST that replies with `text/event-stream`, not JSON. The load
runs as a background task and relays progress through an `asyncio.Queue`:

| event      | payload                                                |
| ---------- | ------------------------------------------------------ |
| `meta`     | `{pages, chunks}` — right after ingest                  |
| `progress` | `{stage: "reading"｜"embedding", done, total}`          |
| `done`     | `{pages, chunks, seconds}`                              |
| `error`    | `{message}` — always the generic line, never the detail |

`ingest_pdf(path, on_page)` and `embed(texts, on_batch)` take progress callbacks;
their logic is otherwise untouched. Parsing runs via `asyncio.to_thread` so the
reading events actually stream instead of arriving in one burst at the end, and
`emit` goes through `loop.call_soon_threadsafe`.

The document summary is **not** in this stream — it is a separate `GET /summary`,
fetched after the stream closes, so the animation never waits on the LLM.

EventSource is GET-only, so the frontend reads the stream with `fetch` and parses
SSE by hand in `readEvents()`.

## The upload animation — read this before touching it
`static/loader.js` owns it. One `<canvas>`, devicePixelRatio-aware, everything
drawn in canvas 2D. No DOM nodes per page, no libraries.

Behind everything, page 1 is rendered with PDF.js into an offscreen canvas and
drawn at 6% opacity with a 3px blur. It is decorative — if it fails, skip it.

- **Phase 1 `reading`** — one cell per page, capped at 400 and mapped
  proportionally beyond that, laid out to fill the panel with 8px gaps.
  Unprocessed cells are a 1px `rgba(79,140,255,0.18)` border. A scan line with a
  soft gradient glow sits at the current progress ratio; cells it passes fill
  with the accent, flashing to alpha 1.0 and easing back to 0.5 over 250ms.
  Caption: `Sahifalar o'qilmoqda · {done}/{total}`
- **Phase 2 `embedding`** — cells detach into particles that ease toward a loose
  radial cloud with slight drift, linking to nearby particles (max ~2 links each
  so it stays readable). Particles activate as batches complete.
  Caption: `Ma'no vektorlariga o'tkazilmoqda · {done}/{total}`
- **Phase 3 `done`** — the cloud pulls into a tight cluster, then fades over
  500ms while the PDF viewer fades in. Elapsed seconds land in the stats strip.

Progress smoothing is what makes it feel real, so do not simplify it away:
- A displayed value eases toward the reported one at ~0.08 per frame and **never
  decreases**, even if the server reports a lower number.
- With no event for 400ms it keeps creeping forward slowly, clamped at 95% until
  `done` arrives.
- If the whole upload takes less than 2.5s the animation is stretched to 2.5s so
  all three phases stay legible. A slower upload is never padded.

Resilience: on `error` the animation stops, the canvas content fades and one line
remains — "Qayta urinib ko'ring.". `prefers-reduced-motion` gives a static grid
with no scan line and no particles. The rAF loop pauses while the tab is hidden.

## The dropzone hero
Before any upload the dropzone is not empty text — `static/hero.js` loops a
miniature of the product so a non-technical viewer sees what it does without
being told: a question types into a small chat, a scan line sweeps a miniature
page, the quote lines light up in the highlight yellow, the answer types in, and
a "7-sahifa" chip pops in and pulses that same highlight.

- The markup is static in `index.html` and every visual state is a CSS class.
  `hero.js` only advances the timeline, so nothing can half-render.
- The hero is `pointer-events: none` — clicks and dropped files still reach the
  dropzone underneath. Never let it capture input.
- One cycle is ~9s: question -> search -> highlight + answer -> chip -> hold ->
  fade -> repeat.
- It stops itself. A `MutationObserver` on the dropzone's `hidden` attribute
  stops the loop when the loader takes over and restarts it if a failed upload
  brings the dropzone back; `visibilitychange` pauses it with the tab. Cancelling
  bumps a token that every step checks, so a stopped cycle unwinds instead of
  drawing into a hidden panel.
- `prefers-reduced-motion` renders the final frame once — full text, lit
  highlight, visible chip — and never starts the loop.
- Hovering the panel lifts the whole thing a little: the border warms toward the
  accent, the stage rises 3px and the instruction brightens. It is deliberately
  weaker than `drag-over` and declared before it, so an actual drag still reads
  as the stronger state.
- It shrinks before the drop instruction does: the caption drops under 660px of
  panel height, the whole hero hides under 520px.

## UI rules
- Dark theme. Background `#0B0E14`, panels `#151A23`, accent `#4F8CFF`,
  highlight overlay `rgba(255, 214, 0, 0.35)`.
- Behind everything sit two fixed aura layers (`body::before` / `body::after`):
  blue `#4F8CFF`, violet `#8B5CF6` and a little cyan `#22D3EE`, drifting over
  34s and 46s. They are the one place the palette leaves the accent blue, they
  never exceed 0.16 alpha, and `prefers-reduced-motion` freezes them. Panels are
  translucent over that aura, so a solid `#151A23` fill is now wrong — use
  `rgba(21, 26, 35, ~0.7)` with a blur. The PDF page itself stays opaque.
- Two-column layout: PDF viewer left (60%), chat right (40%).
- Product name "DocSense" top-left, version badge `v0.9 beta` next to it.
- On upload, the left panel runs the canvas animation above. Never a bare
  spinner, and never a static placeholder caption.
- The question input is sized for a projector, not a laptop: 17px text, 15px
  padding, and `font-family: inherit` — form controls do not inherit the page
  font on their own. The send button matches its height.
- Before a PDF is loaded the chat is locked, and the lock explains itself. A
  button covers the input row — "Savol berish uchun avval PDF yuklang" plus a
  "PDF tanlash" pill — and clicking it opens the file picker and flashes the
  dropzone. The suggested chips are `disabled` and the empty state reads
  "Hujjat yuklansa, shu yerda savol bera olasiz". `enableChat()` undoes all of
  it and focuses the input. Never leave a dead disabled input with no reason
  given.
- While waiting for an answer, show staged status text that advances every
  ~700ms: "Hujjat o'qilmoqda" -> "Tegishli bo'limlar qidirilmoqda" -> "Manba
  tekshirilmoqda" -> "Javob tayyorlanmoqda". Never show a bare spinner.
- Stream the answer token by token, re-rendering the Markdown each step
  (`static/markdown.js`, no library, no CDN) so formatting builds up instead of
  snapping in at the end. The renderer escapes HTML before anything else.
  User messages stay plain text.
- Under each assistant bubble render one chip per source, labelled "N-sahifa".
  More than 3 chips: show 3 and a "+N" expander.
- Above the chips a scope line:
  `specific` -> "Manba";
  `broad` -> "Butun hujjat bo'yicha · {pages} sahifa, {n} bo'lim tahlil qilindi";
  `not_found` -> no chips and no scope line.
- Clicking a chip scrolls to that page and pulses that source's highlight.
- The first source is auto-highlighted on arrival. For `broad` answers do NOT
  auto-scroll — it would jump away from where the user is.
- Never surface stack traces, JSON, or log output in the UI. On any error show:
  "Qayta urinib ko'ring."

## Ollama
Assume Ollama is already running with `qwen3.6:27b`, `bge-m3`, `qwen3:4b` and
`qwen3:32b` pulled. If a call
fails, print a one-line hint to the server console and return a clean error to
the client. Do not add fallback models silently.

## Working style
- One stage at a time. After each stage, tell me exactly how to verify it and
  stop.
- Prefer boring, obvious code. No abstractions with one implementation.
- Keep every file under ~200 lines.
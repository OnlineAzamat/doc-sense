pdfjsLib.GlobalWorkerOptions.workerSrc =
  "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";

const ASK_STAGES = [
  "Hujjat o'qilmoqda",
  "Tegishli bo'limlar qidirilmoqda",
  "Manba tekshirilmoqda",
  "Javob tayyorlanmoqda",
];

const DOC_ICON_SVG =
  '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
  'stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>' +
  '<polyline points="14 2 14 8 20 8"/></svg>';

const dropzone = document.getElementById("dropzone");
const dropzoneText = document.getElementById("dropzone-text");
const fileInput = document.getElementById("file-input");
const pdfViewer = document.getElementById("pdf-viewer");
const pdfCanvas = document.getElementById("pdf-canvas");
const pdfStats = document.getElementById("pdf-stats");
const loaderStage = document.getElementById("loader-stage");
const loaderCanvas = document.getElementById("loader-canvas");
const prevPageBtn = document.getElementById("prev-page");
const nextPageBtn = document.getElementById("next-page");
const pageIndicator = document.getElementById("page-indicator");
const chatInput = document.getElementById("chat-input");
const chatSend = document.getElementById("chat-send");
const chatMessages = document.getElementById("chat-messages");
const chatEmpty = document.getElementById("chat-empty");
const chatEmptyText = document.getElementById("chat-empty-text");
const chatLock = document.getElementById("chat-lock");
const docSummary = document.getElementById("doc-summary");
const docSummaryToggle = document.getElementById("doc-summary-toggle");
const docSummaryBody = document.getElementById("doc-summary-body");
const docSummaryTitle = document.getElementById("doc-summary-title");
const docSummaryText = document.getElementById("doc-summary-text");
const docSummaryTopics = document.getElementById("doc-summary-topics");

const HIGHLIGHT_COLOR_ALPHA = 0.35;
const GENERIC_ERROR = "Qayta urinib ko'ring.";
const CHIP_LIMIT = 3;

let pdfDoc = null;
let currentPage = 1;
let activeHighlight = null;
let cleanPageImageData = null;
let currentRenderTask = null;
let pulseToken = 0;

function formatTime(date) {
  const h = String(date.getHours()).padStart(2, "0");
  const m = String(date.getMinutes()).padStart(2, "0");
  return `${h}:${m}`;
}

// Minimal SSE parser — EventSource is GET-only, and /upload is a POST.
async function* readEvents(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) return;
    buffer += decoder.decode(value, { stream: true });

    let split;
    while ((split = buffer.indexOf("\n\n")) !== -1) {
      const block = buffer.slice(0, split);
      buffer = buffer.slice(split + 2);

      let name = "message";
      let payload = "";
      for (const line of block.split("\n")) {
        if (line.startsWith("event:")) name = line.slice(6).trim();
        else if (line.startsWith("data:")) payload += line.slice(5).trim();
      }
      if (payload) {
        yield { name, data: JSON.parse(payload) };
      }
    }
  }
}

function showDropzoneError() {
  dropzone.classList.add("error");
  dropzoneText.textContent = "Qayta urinib ko'ring.";
  setTimeout(() => {
    dropzone.classList.remove("error");
    dropzoneText.textContent = "PDF faylni shu yerga tashlang yoki tanlang";
  }, 2500);
}

async function loadSummary() {
  try {
    const response = await fetch("/summary");
    if (!response.ok) throw new Error("summary failed");
    renderSummary(await response.json());
  } catch (err) {
    renderSummary(null); // the panel just stays hidden
  }
}

async function uploadFile(file) {
  if (!file || !file.name.toLowerCase().endsWith(".pdf")) {
    showDropzoneError();
    return;
  }

  dropzone.hidden = true;
  loaderStage.hidden = false;
  const loader = DocSenseLoader.create(loaderCanvas, file);
  let meta = null;

  try {
    const formData = new FormData();
    formData.append("file", file);
    const response = await fetch("/upload", { method: "POST", body: formData });
    if (!response.ok) {
      throw new Error("upload failed");
    }

    let finalEvent = null;
    for await (const { name, data } of readEvents(response)) {
      if (name === "meta") meta = data;
      else if (name === "progress") loader.progress(data);
      else if (name === "done" || name === "error") {
        finalEvent = { name, data };
        break;
      }
    }

    if (!finalEvent || finalEvent.name !== "done") {
      throw new Error("upload failed");
    }

    // Render the viewer behind the still-running animation so it is laid out
    // and ready; then the two cross-fade.
    activeHighlight = null;
    pdfViewer.hidden = false;
    pdfViewer.style.opacity = "0";
    await renderPdf("/pdf");
    renderStats(meta, finalEvent.data);

    await loader.finish(() => {
      pdfViewer.style.opacity = "1";
    });
    loader.destroy();
    loaderStage.hidden = true;
    enableChat();
    loadSummary();
  } catch (err) {
    loader.fail();
    pdfViewer.hidden = true;
    setTimeout(() => {
      loader.destroy();
      loaderStage.hidden = true;
      dropzone.hidden = false;
      showDropzoneError();
    }, 1600);
  }
}

function renderStats(meta, done) {
  const pages = (meta && meta.pages) || done.pages;
  const chunks = (meta && meta.chunks) || done.chunks;
  const suffix = done.cached ? " · keshdan" : "";
  pdfStats.textContent = `${pages} sahifa · ${chunks} bo'lim · ${done.seconds}s${suffix}`;
}

function enableChat() {
  chatInput.disabled = false;
  chatSend.disabled = false;
  chatLock.hidden = true;
  chatEmptyText.textContent = "Hujjatingiz haqida savol bering";
  document
    .querySelectorAll(".suggested-chip")
    .forEach((chip) => (chip.disabled = false));
  chatInput.focus();
}

function renderSummary(summary) {
  if (!summary || !summary.title) {
    docSummary.hidden = true;
    return;
  }

  docSummaryTitle.textContent = summary.title;
  docSummaryText.textContent = summary.summary;
  docSummaryTopics.innerHTML = "";
  for (const topic of summary.topics || []) {
    const pill = document.createElement("span");
    pill.className = "topic-pill";
    pill.textContent = topic;
    docSummaryTopics.appendChild(pill);
  }
  docSummary.hidden = false;
}

docSummaryToggle.addEventListener("click", () => {
  const expanded = docSummaryToggle.classList.toggle("expanded");
  docSummaryBody.hidden = !expanded;
});

async function renderPdf(url) {
  pdfDoc = await pdfjsLib.getDocument(url).promise;
  currentPage = 1;
  await renderPage(currentPage);
}

async function renderPage(num) {
  pulseToken += 1; // invalidate any in-flight pulse animation targeting the old page

  if (currentRenderTask) {
    currentRenderTask.cancel();
  }

  const page = await pdfDoc.getPage(num);
  const wrap = pdfCanvas.parentElement;
  const unscaledViewport = page.getViewport({ scale: 1 });
  const scale = (wrap.clientWidth - 24) / unscaledViewport.width;
  const viewport = page.getViewport({ scale });

  pdfCanvas.width = viewport.width;
  pdfCanvas.height = viewport.height;

  const ctx = pdfCanvas.getContext("2d");
  const renderTask = page.render({ canvasContext: ctx, viewport });
  currentRenderTask = renderTask;

  try {
    await renderTask.promise;
  } catch (err) {
    if (err && err.name === "RenderingCancelledException") {
      return; // a newer renderPage() call superseded this one
    }
    throw err;
  }
  if (currentRenderTask === renderTask) {
    currentRenderTask = null;
  }

  cleanPageImageData = ctx.getImageData(0, 0, pdfCanvas.width, pdfCanvas.height);

  pageIndicator.textContent = `${num} / ${pdfDoc.numPages}`;
  prevPageBtn.disabled = num <= 1;
  nextPageBtn.disabled = num >= pdfDoc.numPages;

  if (activeHighlight && activeHighlight.pageNo === num) {
    drawHighlight(activeHighlight.rects, activeHighlight.pageWidth, activeHighlight.pageHeight);
  }
}

function drawHighlight(rects, pdfPageWidth, pdfPageHeight, alpha = HIGHLIGHT_COLOR_ALPHA) {
  const ctx = pdfCanvas.getContext("2d");
  const scaleX = pdfCanvas.width / pdfPageWidth;
  const scaleY = pdfCanvas.height / pdfPageHeight;

  ctx.fillStyle = `rgba(255, 214, 0, ${alpha})`;
  for (const [x0, y0, x1, y1] of rects) {
    ctx.fillRect(x0 * scaleX, y0 * scaleY, (x1 - x0) * scaleX, (y1 - y0) * scaleY);
  }
}

function scrollHighlightIntoView() {
  if (!activeHighlight || !activeHighlight.rects.length) {
    return;
  }
  const wrap = pdfCanvas.parentElement;
  const scaleY = pdfCanvas.height / activeHighlight.pageHeight;
  const [, y0, , y1] = activeHighlight.rects[0];
  const centerY = ((y0 + y1) / 2) * scaleY;
  wrap.scrollTop = Math.max(centerY - wrap.clientHeight / 2, 0);
}

function pulseHighlight() {
  if (!activeHighlight || !cleanPageImageData) {
    return;
  }
  const myToken = ++pulseToken;
  const ctx = pdfCanvas.getContext("2d");
  const duration = 1100;
  const start = performance.now();

  function frame(now) {
    if (myToken !== pulseToken) {
      return; // superseded by a newer page render or pulse
    }
    const t = (now - start) / duration;
    if (t >= 1) {
      ctx.putImageData(cleanPageImageData, 0, 0);
      drawHighlight(activeHighlight.rects, activeHighlight.pageWidth, activeHighlight.pageHeight);
      return;
    }
    const alpha = 0.3 + 0.35 * Math.abs(Math.sin(t * Math.PI * 3));
    ctx.putImageData(cleanPageImageData, 0, 0);
    drawHighlight(activeHighlight.rects, activeHighlight.pageWidth, activeHighlight.pageHeight, alpha);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

async function showSource(source, scroll) {
  activeHighlight = {
    pageNo: source.page_no,
    rects: source.rects,
    pageWidth: source.page_width,
    pageHeight: source.page_height,
  };
  currentPage = source.page_no;
  await renderPage(source.page_no);
  if (scroll) {
    scrollHighlightIntoView();
  }
  pulseHighlight();
}

function hideChatEmpty() {
  if (chatEmpty) {
    chatEmpty.hidden = true;
  }
}

function appendUserMessage(text) {
  hideChatEmpty();

  const wrap = document.createElement("div");
  wrap.className = "chat-msg-wrap chat-msg-wrap-user";

  const bubble = document.createElement("div");
  bubble.className = "chat-msg chat-msg-user";
  bubble.textContent = text;

  const timeEl = document.createElement("span");
  timeEl.className = "msg-time";
  timeEl.textContent = formatTime(new Date());

  wrap.appendChild(bubble);
  wrap.appendChild(timeEl);
  chatMessages.appendChild(wrap);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function appendAssistantMessage() {
  hideChatEmpty();

  const wrap = document.createElement("div");
  wrap.className = "chat-msg-wrap chat-msg-wrap-assistant";

  const bubble = document.createElement("div");
  bubble.className = "chat-msg chat-msg-assistant";

  const statusEl = document.createElement("div");
  const textEl = document.createElement("div");
  textEl.className = "answer-text";
  const sourceEl = document.createElement("div");
  sourceEl.className = "msg-source";
  sourceEl.hidden = true;

  bubble.appendChild(statusEl);
  bubble.appendChild(textEl);
  bubble.appendChild(sourceEl);

  const timeEl = document.createElement("span");
  timeEl.className = "msg-time";
  timeEl.textContent = formatTime(new Date());

  wrap.appendChild(bubble);
  wrap.appendChild(timeEl);
  chatMessages.appendChild(wrap);
  chatMessages.scrollTop = chatMessages.scrollHeight;

  return { statusEl, textEl, sourceEl };
}

function startAskStatus(container) {
  const list = document.createElement("div");
  list.className = "status-list";
  container.appendChild(list);

  const stepEls = [];
  let stageIndex = -1;
  let timer = null;

  function renderStep(idx) {
    const step = document.createElement("div");
    step.className = "status-step status-step-current";

    const dot = document.createElement("span");
    dot.className = "status-dot";
    const check = document.createElement("span");
    check.className = "status-check";
    check.textContent = "✓";
    const label = document.createElement("span");
    label.className = "status-label";
    label.textContent = ASK_STAGES[idx];

    step.appendChild(dot);
    step.appendChild(check);
    step.appendChild(label);
    list.appendChild(step);
    stepEls.push(step);
    chatMessages.scrollTop = chatMessages.scrollHeight;

    requestAnimationFrame(() => step.classList.add("status-step-visible"));
  }

  function advance() {
    if (stageIndex >= 0) {
      const prev = stepEls[stageIndex];
      prev.classList.remove("status-step-current");
      prev.classList.add("status-step-done");
    }
    if (stageIndex < ASK_STAGES.length - 1) {
      stageIndex += 1;
      renderStep(stageIndex);
      if (stageIndex === ASK_STAGES.length - 1 && timer) {
        clearInterval(timer);
      }
    }
  }

  advance();
  timer = setInterval(advance, 700);

  function stop() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  function collapse() {
    stop();
    list.innerHTML = "";
    list.className = "status-collapsed";
    list.textContent = "Tahlil yakunlandi";
  }

  return { stop, collapse };
}

function revealText(el, text) {
  // Typed word by word, re-rendered as Markdown each step so lists, tables and
  // bold terms build up formatted instead of snapping into place at the end.
  return new Promise((resolve) => {
    const pieces = text.split(/(\s+)/);
    let shown = "";
    let i = 0;
    el.innerHTML = "";
    const timer = setInterval(() => {
      if (i >= pieces.length) {
        clearInterval(timer);
        el.innerHTML = renderMarkdown(text);
        resolve();
        return;
      }
      shown += pieces[i];
      el.innerHTML = renderMarkdown(shown);
      chatMessages.scrollTop = chatMessages.scrollHeight;
      i += 1;
    }, 35);
  });
}

function confidenceLabel(score) {
  if (score >= 0.55) return "Yuqori ishonch";
  if (score >= 0.4) return "O'rta ishonch";
  return "Past ishonch";
}

function scopeLineText(scope, analyzed) {
  if (scope === "broad") {
    const pages = (analyzed && analyzed.pages) || 0;
    const sections = (analyzed && analyzed.sections) || 0;
    return `Butun hujjat bo'yicha · ${pages} sahifa, ${sections} bo'lim tahlil qilindi`;
  }
  return "Manba";
}

function makeChip(source) {
  const chip = document.createElement("button");
  chip.type = "button";
  chip.className = "source-chip";
  chip.innerHTML = `${DOC_ICON_SVG}<span>${source.page_no}-sahifa</span>`;
  chip.addEventListener("click", () => showSource(source, true));
  return chip;
}

function renderSources(container, data, score) {
  container.innerHTML = "";

  const sources = data.sources || [];
  if (data.scope === "not_found" || !sources.length) {
    container.hidden = true;
    return;
  }

  const scopeLine = document.createElement("div");
  scopeLine.className = "source-scope";
  scopeLine.textContent = scopeLineText(data.scope, data.analyzed);
  container.appendChild(scopeLine);

  const chips = document.createElement("div");
  chips.className = "source-chips";
  container.appendChild(chips);

  const visible = sources.slice(0, CHIP_LIMIT);
  const hidden = sources.slice(CHIP_LIMIT);
  visible.forEach((source) => chips.appendChild(makeChip(source)));

  if (hidden.length) {
    const more = document.createElement("button");
    more.type = "button";
    more.className = "source-chip source-more";
    more.textContent = `+${hidden.length}`;
    more.addEventListener("click", () => {
      more.remove();
      hidden.forEach((source) => chips.appendChild(makeChip(source)));
    });
    chips.appendChild(more);
  }

  if (data.scope === "specific" && typeof score === "number") {
    const wrap = document.createElement("div");
    wrap.className = "confidence-wrap";

    const bar = document.createElement("div");
    bar.className = "confidence-bar";
    const fill = document.createElement("div");
    fill.className = "confidence-fill";
    fill.style.width = `${Math.round(Math.min(Math.max(score, 0), 1) * 100)}%`;
    bar.appendChild(fill);

    const label = document.createElement("span");
    label.className = "confidence-label";
    label.textContent = confidenceLabel(score);

    wrap.appendChild(bar);
    wrap.appendChild(label);
    container.appendChild(wrap);
  }

  container.hidden = false;
}

async function handleAsk(presetQuestion) {
  const question = (presetQuestion !== undefined ? presetQuestion : chatInput.value).trim();
  if (!question || chatInput.disabled) {
    return;
  }

  chatInput.value = "";
  chatInput.disabled = true;
  chatSend.disabled = true;

  appendUserMessage(question);
  const { statusEl, textEl, sourceEl } = appendAssistantMessage();
  const status = startAskStatus(statusEl);

  try {
    const response = await fetch("/ask", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question }),
    });

    if (!response.ok) {
      throw new Error("ask failed");
    }

    const data = await response.json();
    status.collapse();
    await revealText(textEl, data.answer || GENERIC_ERROR);

    renderSources(sourceEl, data, data.top_score);

    const sources = data.sources || [];
    if (sources.length && pdfDoc) {
      // Auto-highlight the first source. A broad answer spans the whole
      // document, so don't scroll the viewer away from where the user is.
      await showSource(sources[0], data.scope === "specific");
    }
  } catch (err) {
    status.stop();
    statusEl.innerHTML = "";
    textEl.textContent = GENERIC_ERROR;
  } finally {
    chatInput.disabled = false;
    chatSend.disabled = false;
    chatInput.focus();
  }
}

chatSend.addEventListener("click", () => handleAsk());

chatInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    handleAsk();
  }
});

document.querySelectorAll(".suggested-chip").forEach((chip) => {
  chip.addEventListener("click", () => handleAsk(chip.textContent));
});

dropzone.addEventListener("click", () => fileInput.click());

// The locked chat row unlocks itself: it opens the picker and flashes the
// dropzone, so the answer to "why can't I type?" is on screen either way.
chatLock.addEventListener("click", () => {
  fileInput.click();
  dropzone.classList.remove("attention");
  void dropzone.offsetWidth;
  dropzone.classList.add("attention");
  setTimeout(() => dropzone.classList.remove("attention"), 1900);
});

fileInput.addEventListener("change", () => {
  if (fileInput.files[0]) {
    uploadFile(fileInput.files[0]);
  }
});

dropzone.addEventListener("dragover", (event) => {
  event.preventDefault();
  dropzone.classList.add("drag-over");
});

dropzone.addEventListener("dragleave", () => {
  dropzone.classList.remove("drag-over");
});

dropzone.addEventListener("drop", (event) => {
  event.preventDefault();
  dropzone.classList.remove("drag-over");
  const file = event.dataTransfer.files[0];
  if (file) {
    uploadFile(file);
  }
});

prevPageBtn.addEventListener("click", () => {
  if (currentPage > 1) {
    currentPage -= 1;
    renderPage(currentPage);
  }
});

nextPageBtn.addEventListener("click", () => {
  if (pdfDoc && currentPage < pdfDoc.numPages) {
    currentPage += 1;
    renderPage(currentPage);
  }
});

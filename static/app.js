pdfjsLib.GlobalWorkerOptions.workerSrc =
  "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";

const UPLOAD_STAGES = [
  "Hujjat indekslanmoqda",
  "Tegishli bo'limlar qidirilmoqda",
  "Javob tayyorlanmoqda",
];

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
const prevPageBtn = document.getElementById("prev-page");
const nextPageBtn = document.getElementById("next-page");
const pageIndicator = document.getElementById("page-indicator");
const chatInput = document.getElementById("chat-input");
const chatSend = document.getElementById("chat-send");
const chatMessages = document.getElementById("chat-messages");
const chatEmpty = document.getElementById("chat-empty");
const docSummary = document.getElementById("doc-summary");
const docSummaryToggle = document.getElementById("doc-summary-toggle");
const docSummaryBody = document.getElementById("doc-summary-body");
const docSummaryTitle = document.getElementById("doc-summary-title");
const docSummaryText = document.getElementById("doc-summary-text");
const docSummaryTopics = document.getElementById("doc-summary-topics");

const HIGHLIGHT_COLOR_ALPHA = 0.35;
const GENERIC_ERROR = "Qayta urinib ko'ring.";

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

function startStagedStatus(el) {
  let stageIndex = 0;
  el.textContent = UPLOAD_STAGES[0];
  const timer = setInterval(() => {
    stageIndex = (stageIndex + 1) % UPLOAD_STAGES.length;
    el.textContent = UPLOAD_STAGES[stageIndex];
  }, 600);
  return () => clearInterval(timer);
}

function showDropzoneError() {
  dropzone.classList.add("error");
  dropzoneText.textContent = "Qayta urinib ko'ring.";
  setTimeout(() => {
    dropzone.classList.remove("error");
    dropzoneText.textContent = "PDF faylni shu yerga tashlang yoki tanlang";
  }, 2500);
}

async function uploadFile(file) {
  if (!file || !file.name.toLowerCase().endsWith(".pdf")) {
    showDropzoneError();
    return;
  }

  const stopStatus = startStagedStatus(dropzoneText);

  try {
    const formData = new FormData();
    formData.append("file", file);
    const response = await fetch("/upload", { method: "POST", body: formData });
    if (!response.ok) {
      throw new Error("upload failed");
    }

    const data = await response.json();
    stopStatus();
    dropzone.hidden = true;
    pdfViewer.hidden = false;
    activeHighlight = null;
    await renderPdf("/pdf");
    renderSummary(data.summary);
    enableChat();
  } catch (err) {
    stopStatus();
    showDropzoneError();
  }
}

function enableChat() {
  chatInput.disabled = false;
  chatSend.disabled = false;
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

async function revealHighlight(pageNo) {
  currentPage = pageNo;
  await renderPage(pageNo);
  scrollHighlightIntoView();
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
  return new Promise((resolve) => {
    const pieces = text.split(/(\s+)/);
    let i = 0;
    el.textContent = "";
    const timer = setInterval(() => {
      if (i >= pieces.length) {
        clearInterval(timer);
        resolve();
        return;
      }
      el.textContent += pieces[i];
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

function renderSourceChip(container, pageNo, score) {
  container.innerHTML = "";

  const chip = document.createElement("button");
  chip.type = "button";
  chip.className = "source-chip";
  chip.innerHTML = `${DOC_ICON_SVG}<span>Manba — ${pageNo}-sahifa</span>`;
  chip.addEventListener("click", () => revealHighlight(pageNo));
  container.appendChild(chip);

  if (typeof score === "number") {
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

    if (data.found && data.page_no && pdfDoc) {
      activeHighlight = {
        pageNo: data.page_no,
        rects: data.rects,
        pageWidth: data.page_width,
        pageHeight: data.page_height,
      };
      renderSourceChip(sourceEl, data.page_no, data.top_score);
      await revealHighlight(data.page_no);
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

pdfjsLib.GlobalWorkerOptions.workerSrc =
  "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";

const STATUS_STAGES = [
  "Hujjat indekslanmoqda",
  "Tegishli bo'limlar qidirilmoqda",
  "Javob tayyorlanmoqda",
];

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

const HIGHLIGHT_COLOR = "rgba(255, 214, 0, 0.35)";
const GENERIC_ERROR = "Qayta urinib ko'ring.";

let pdfDoc = null;
let currentPage = 1;
let activeHighlight = null;

function startStagedStatus(el) {
  let stageIndex = 0;
  el.textContent = STATUS_STAGES[0];
  const timer = setInterval(() => {
    stageIndex = (stageIndex + 1) % STATUS_STAGES.length;
    el.textContent = STATUS_STAGES[stageIndex];
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

    stopStatus();
    dropzone.hidden = true;
    pdfViewer.hidden = false;
    await renderPdf("/pdf");
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

async function renderPdf(url) {
  pdfDoc = await pdfjsLib.getDocument(url).promise;
  currentPage = 1;
  await renderPage(currentPage);
}

async function renderPage(num) {
  const page = await pdfDoc.getPage(num);
  const wrap = pdfCanvas.parentElement;
  const unscaledViewport = page.getViewport({ scale: 1 });
  const scale = (wrap.clientWidth - 24) / unscaledViewport.width;
  const viewport = page.getViewport({ scale });

  pdfCanvas.width = viewport.width;
  pdfCanvas.height = viewport.height;

  await page.render({ canvasContext: pdfCanvas.getContext("2d"), viewport }).promise;

  pageIndicator.textContent = `${num} / ${pdfDoc.numPages}`;
  prevPageBtn.disabled = num <= 1;
  nextPageBtn.disabled = num >= pdfDoc.numPages;

  if (activeHighlight && activeHighlight.pageNo === num) {
    drawHighlight(activeHighlight.rects, activeHighlight.pageWidth, activeHighlight.pageHeight);
  }
}

function drawHighlight(rects, pdfPageWidth, pdfPageHeight) {
  const ctx = pdfCanvas.getContext("2d");
  const scaleX = pdfCanvas.width / pdfPageWidth;
  const scaleY = pdfCanvas.height / pdfPageHeight;

  ctx.fillStyle = HIGHLIGHT_COLOR;
  for (const [x0, y0, x1, y1] of rects) {
    ctx.fillRect(x0 * scaleX, y0 * scaleY, (x1 - x0) * scaleX, (y1 - y0) * scaleY);
  }
}

function appendMessage(role, text) {
  const el = document.createElement("div");
  el.className = `chat-msg chat-msg-${role}`;
  el.textContent = text;
  chatMessages.appendChild(el);
  chatMessages.scrollTop = chatMessages.scrollHeight;
  return el;
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

async function handleAsk() {
  const question = chatInput.value.trim();
  if (!question) {
    return;
  }

  chatInput.value = "";
  chatInput.disabled = true;
  chatSend.disabled = true;

  appendMessage("user", question);
  const replyEl = appendMessage("assistant", "");
  const stopStatus = startStagedStatus(replyEl);

  try {
    const response = await fetch("/ask", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question }),
    });
    stopStatus();

    if (!response.ok) {
      throw new Error("ask failed");
    }

    const data = await response.json();
    await revealText(replyEl, data.answer || GENERIC_ERROR);

    if (data.found && data.page_no && pdfDoc) {
      activeHighlight = {
        pageNo: data.page_no,
        rects: data.rects,
        pageWidth: data.page_width,
        pageHeight: data.page_height,
      };
      currentPage = data.page_no;
      await renderPage(currentPage);
    }
  } catch (err) {
    stopStatus();
    replyEl.textContent = GENERIC_ERROR;
  } finally {
    chatInput.disabled = false;
    chatSend.disabled = false;
    chatInput.focus();
  }
}

chatSend.addEventListener("click", handleAsk);

chatInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    handleAsk();
  }
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

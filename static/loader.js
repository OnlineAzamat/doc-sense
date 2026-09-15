// Canvas analysis animation shown while a PDF is being read and embedded.
// Driven by real progress events from /upload; see app.js.

const MAX_CELLS = 400;
const GAP = 8;
const CAPTION_H = 34;
const MIN_DURATION = 2500;
const FLASH_MS = 250;
const CREEP_AFTER_MS = 400;
const CREEP_CLAMP = 0.95;
const LERP = 0.08;
const CLUSTER_MS = 450;
const FADE_MS = 500;
const TAU = Math.PI * 2;

const CAPTIONS = {
  reading: "Sahifalar o'qilmoqda",
  embedding: "Ma'no vektorlariga o'tkazilmoqda",
};

function easeOut(t) {
  return 1 - (1 - t) * (1 - t);
}

function createLoader(canvas, file) {
  const ctx = canvas.getContext("2d");
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const startedAt = performance.now();

  let w = 0;
  let h = 0;
  let gridH = 0;
  let cells = [];
  let phase = "reading";
  let raf = null;
  let stopped = false;
  let backdrop = null;
  let clamp = CREEP_CLAMP;
  let clusterAt = 0;
  let errorAt = 0;
  let finished = null;
  let fadeStarted = null;

  const tracks = {
    reading: { target: 0, shown: 0, done: 0, total: 0, at: startedAt },
    embedding: { target: 0, shown: 0, done: 0, total: 0, at: startedAt },
  };

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    w = Math.max(rect.width, 1);
    h = Math.max(rect.height, 1);
    gridH = Math.max(h - CAPTION_H, 40);
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    layout();
  }

  function buildCells(pages) {
    const n = Math.max(1, Math.min(pages, MAX_CELLS));
    cells = [];
    for (let i = 0; i < n; i++) {
      cells.push({
        x: 0, y: 0, gx: 0, gy: 0, w: 0, h: 0, r: 0,
        tx: 0, ty: 0, litAt: 0,
        dp: Math.random() * TAU,
        ds: 0.4 + Math.random() * 0.6,
        da: 3 + Math.random() * 5,
      });
    }
    layout();
  }

  function layout() {
    if (!cells.length) return;
    const n = cells.length;
    const cols = Math.max(1, Math.round(Math.sqrt((n * w) / gridH)));
    const rows = Math.ceil(n / cols);
    const cw = Math.max((w - GAP * (cols - 1)) / cols, 2);
    const ch = Math.max((gridH - GAP * (rows - 1)) / rows, 2);
    cells.forEach((c, i) => {
      c.gx = (i % cols) * (cw + GAP);
      c.gy = Math.floor(i / cols) * (ch + GAP);
      c.w = cw;
      c.h = ch;
      if (phase === "reading") {
        c.x = c.gx + cw / 2;
        c.y = c.gy + ch / 2;
        c.r = Math.min(cw, ch) / 2;
      }
    });
  }

  function scatter(tight) {
    const cx = w / 2;
    const cy = gridH / 2;
    const maxR = Math.min(w, gridH) * (tight ? 0.12 : 0.42);
    for (const c of cells) {
      const a = Math.random() * TAU;
      const r = (0.2 + 0.8 * Math.sqrt(Math.random())) * maxR;
      c.tx = cx + Math.cos(a) * r;
      c.ty = cy + Math.sin(a) * r * 0.85;
    }
  }

  function setPhase(next) {
    if (phase === next) return;
    phase = next;
    if (next === "embedding") scatter(false);
    if (next === "done") {
      scatter(true);
      clusterAt = performance.now();
    }
  }

  function advance(tr, now) {
    if (now - tr.at > CREEP_AFTER_MS) {
      tr.target = Math.min(Math.max(tr.target, tr.shown) + 0.0006, clamp);
    }
    const next = tr.shown + (tr.target - tr.shown) * LERP;
    tr.shown = Math.max(tr.shown, next); // never goes backwards
  }

  function drawBackdrop() {
    if (!backdrop) return;
    ctx.save();
    ctx.globalAlpha = 0.06;
    ctx.filter = "blur(3px)";
    const s = Math.min(w / backdrop.width, h / backdrop.height);
    const bw = backdrop.width * s;
    const bh = backdrop.height * s;
    ctx.drawImage(backdrop, (w - bw) / 2, (h - bh) / 2, bw, bh);
    ctx.restore();
  }

  function drawGrid(now) {
    const scanY = tracks.reading.shown * gridH;
    for (const c of cells) {
      if (!reduced && !c.litAt && scanY >= c.gy + c.h * 0.6) c.litAt = now;
      const lit = reduced ? c.gy + c.h * 0.6 <= scanY : c.litAt > 0;
      if (lit) {
        const t = reduced ? 1 : Math.min(1, (now - c.litAt) / FLASH_MS);
        ctx.fillStyle = `rgba(79, 140, 255, ${1 - 0.5 * easeOut(t)})`;
        ctx.fillRect(c.gx, c.gy, c.w, c.h);
      } else {
        ctx.strokeStyle = "rgba(79, 140, 255, 0.18)";
        ctx.lineWidth = 1;
        ctx.strokeRect(c.gx + 0.5, c.gy + 0.5, c.w - 1, c.h - 1);
      }
    }
    if (reduced) return;

    const g = ctx.createLinearGradient(0, scanY - 46, 0, scanY + 46);
    g.addColorStop(0, "rgba(79, 140, 255, 0)");
    g.addColorStop(0.5, "rgba(79, 140, 255, 0.45)");
    g.addColorStop(1, "rgba(79, 140, 255, 0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, scanY - 46, w, 92);
    ctx.fillStyle = "rgba(150, 190, 255, 0.9)";
    ctx.fillRect(0, scanY - 1, w, 2);
  }

  function drawCloud(now) {
    const t = now / 1000;
    const ratio = phase === "done" ? 1 : tracks.embedding.shown;
    const activeCount = Math.max(1, Math.round(ratio * cells.length));
    const active = [];

    for (let i = 0; i < cells.length; i++) {
      const c = cells[i];
      const px = c.tx + Math.cos(c.dp + t * c.ds) * c.da;
      const py = c.ty + Math.sin(c.dp * 1.7 + t * c.ds) * c.da;
      c.x += (px - c.x) * 0.06;
      c.y += (py - c.y) * 0.06;
      c.r += (3 - c.r) * 0.08;
      if (i < activeCount) active.push(c);
    }

    const th = Math.min(w, gridH) * 0.13;
    ctx.lineWidth = 1;
    for (let i = 0; i < active.length; i++) {
      const a = active[i];
      let links = 0;
      for (let j = i + 1; j < active.length && links < 2; j++) {
        const b = active[j];
        const dx = a.x - b.x;
        const dy = a.y - b.y;
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d > th) continue;
        ctx.strokeStyle = `rgba(79, 140, 255, ${(1 - d / th) * 0.35})`;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
        links++;
      }
    }

    for (let i = 0; i < cells.length; i++) {
      const c = cells[i];
      ctx.fillStyle = i < activeCount ? "rgba(79, 140, 255, 0.95)" : "rgba(79, 140, 255, 0.25)";
      ctx.beginPath();
      ctx.arc(c.x, c.y, Math.max(c.r, 1), 0, TAU);
      ctx.fill();
    }
  }

  function drawCaption(text) {
    ctx.fillStyle = "#6b7280";
    ctx.font = "12px system-ui, -apple-system, 'Segoe UI', sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";
    ctx.fillText(text, w / 2, h - 12);
  }

  function frame() {
    const now = performance.now();
    ctx.clearRect(0, 0, w, h);

    if (errorAt) {
      // Fade the animation out but keep the one line readable.
      const t = Math.min(1, (now - errorAt) / 400);
      ctx.save();
      ctx.globalAlpha = 1 - t;
      drawBackdrop();
      if (cells.length) {
        if (phase === "reading" || reduced) drawGrid(now);
        else drawCloud(now);
      }
      ctx.restore();
      drawCaption("Qayta urinib ko'ring.");
      if (t >= 1) return stop();
      raf = requestAnimationFrame(frame);
      return;
    }

    advance(tracks.reading, now);
    advance(tracks.embedding, now);
    drawBackdrop();

    if (phase === "reading") {
      drawGrid(now);
      drawCaption(`${CAPTIONS.reading} · ${tracks.reading.done}/${tracks.reading.total}`);
    } else if (phase === "embedding") {
      if (reduced) drawGrid(now);
      else drawCloud(now);
      drawCaption(`${CAPTIONS.embedding} · ${tracks.embedding.done}/${tracks.embedding.total}`);
    } else {
      if (reduced) drawGrid(now);
      else drawCloud(now);
      const fadeAt = clusterAt + (reduced ? 0 : CLUSTER_MS);
      if (now >= fadeAt) {
        if (fadeStarted) {
          fadeStarted(); // hand off: the PDF viewer fades in as the cloud fades out
          fadeStarted = null;
        }
        const t = Math.min(1, (now - fadeAt) / FADE_MS);
        canvas.style.opacity = String(1 - t);
        if (t >= 1) {
          stop();
          if (finished) finished();
          return;
        }
      }
    }

    raf = requestAnimationFrame(frame);
  }

  function start() {
    if (raf === null && !stopped) raf = requestAnimationFrame(frame);
  }

  function stop() {
    if (raf !== null) cancelAnimationFrame(raf);
    raf = null;
  }

  function onVisibility() {
    if (document.hidden) stop();
    else start();
  }

  async function loadBackdrop() {
    try {
      const url = URL.createObjectURL(file);
      const doc = await pdfjsLib.getDocument(url).promise;
      const page = await doc.getPage(1);
      const base = page.getViewport({ scale: 1 });
      const scale = Math.min(900 / base.width, 1.5);
      const viewport = page.getViewport({ scale });
      const off = document.createElement("canvas");
      off.width = Math.max(1, Math.round(viewport.width));
      off.height = Math.max(1, Math.round(viewport.height));
      await page.render({ canvasContext: off.getContext("2d"), viewport }).promise;
      backdrop = off;
      URL.revokeObjectURL(url);
    } catch (err) {
      backdrop = null; // decorative only — skip it
    }
  }

  window.addEventListener("resize", resize);
  document.addEventListener("visibilitychange", onVisibility);
  canvas.style.opacity = "1";
  resize();
  loadBackdrop();
  start();

  return {
    progress(data) {
      const tr = tracks[data.stage];
      if (!tr) return;
      if (data.stage === "reading" && !cells.length && data.total) buildCells(data.total);
      if (data.stage === "embedding") setPhase("embedding");
      tr.done = data.done;
      tr.total = data.total;
      tr.at = performance.now();
      if (data.total > 0) tr.target = Math.max(tr.target, Math.min(data.done / data.total, clamp));
    },

    finish(onFade) {
      // Hold the phases on screen long enough to read them, even on a tiny PDF.
      return new Promise((resolve) => {
        finished = resolve;
        fadeStarted = onFade || null;
        clamp = 1;
        tracks.reading.target = 1;
        tracks.embedding.target = 1;
        if (!cells.length) buildCells(1);
        setPhase("embedding");
        const wait = Math.max(0, MIN_DURATION - (performance.now() - startedAt));
        setTimeout(() => setPhase("done"), wait);
      });
    },

    fail() {
      errorAt = performance.now();
      start();
    },

    destroy() {
      stopped = true;
      stop();
      window.removeEventListener("resize", resize);
      document.removeEventListener("visibilitychange", onVisibility);
    },
  };
}

window.DocSenseLoader = { create: createLoader };

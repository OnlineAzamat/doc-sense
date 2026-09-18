// Looping mini-demo shown inside the dropzone before any PDF is uploaded.
// It replays what the product does: a question, a matching passage lighting up
// inside the page, an answer, and the source chip. CSS owns every visual state;
// this file only advances the timeline and can be stopped at any point.

const HERO_QUESTION = "Shartnoma muddati qancha?";
const HERO_ANSWER = "Shartnoma imzolangan kundan boshlab 12 oy muddatga tuziladi.";
const HERO_TYPE_MS = 34;

(function () {
  const hero = document.getElementById("hero");
  const dropzone = document.getElementById("dropzone");
  if (!hero || !dropzone) return;

  const stage = document.getElementById("hero-stage");
  const page = document.getElementById("hero-page");
  const qBubble = document.getElementById("hero-q");
  const aBubble = document.getElementById("hero-a");
  const status = document.getElementById("hero-status");
  const source = document.getElementById("hero-source");
  const qText = qBubble.querySelector("span");
  const aText = aBubble.querySelector("span");
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  let token = 0;

  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function reset() {
    stage.classList.remove("out");
    page.classList.remove("lit", "pulse", "scanning");
    qBubble.classList.remove("on", "typing");
    aBubble.classList.remove("on", "typing");
    status.classList.remove("on");
    source.classList.remove("on");
    qText.textContent = "";
    aText.textContent = "";
  }

  function replay(el, cls) {
    el.classList.remove(cls);
    void el.offsetWidth; // restart the animation
    el.classList.add(cls);
  }

  async function type(el, text, mine) {
    for (let i = 1; i <= text.length; i++) {
      if (mine !== token) return;
      el.textContent = text.slice(0, i);
      await wait(HERO_TYPE_MS);
    }
  }

  function showFinalFrame() {
    reset();
    qText.textContent = HERO_QUESTION;
    aText.textContent = HERO_ANSWER;
    qBubble.classList.add("on");
    aBubble.classList.add("on");
    source.classList.add("on");
    page.classList.add("lit");
  }

  async function cycle(mine) {
    reset();
    await wait(600);
    if (mine !== token) return;

    qBubble.classList.add("on", "typing");
    await type(qText, HERO_QUESTION, mine);
    if (mine !== token) return;
    qBubble.classList.remove("typing");

    await wait(320);
    if (mine !== token) return;
    status.classList.add("on");
    replay(page, "scanning");

    await wait(1550);
    if (mine !== token) return;
    status.classList.remove("on");
    page.classList.add("lit");
    replay(page, "pulse");

    aBubble.classList.add("on", "typing");
    await type(aText, HERO_ANSWER, mine);
    if (mine !== token) return;
    aBubble.classList.remove("typing");

    await wait(400);
    if (mine !== token) return;
    source.classList.add("on");
    replay(page, "pulse"); // the chip and the highlight belong together

    await wait(2600);
    if (mine !== token) return;
    stage.classList.add("out");
    await wait(700);
  }

  async function run() {
    const mine = ++token;
    while (mine === token) {
      await cycle(mine);
    }
  }

  function stop() {
    token += 1; // pending timers resolve into a token check and unwind
  }

  function sync() {
    if (dropzone.hidden || document.hidden) stop();
    else if (!reduced) run();
  }

  if (reduced) {
    showFinalFrame();
    return;
  }

  // Self-contained: the demo stops when the dropzone gives way to the loader,
  // and starts again if an upload fails and the dropzone comes back.
  new MutationObserver(sync).observe(dropzone, {
    attributes: true,
    attributeFilter: ["hidden"],
  });
  document.addEventListener("visibilitychange", sync);
  sync();
})();

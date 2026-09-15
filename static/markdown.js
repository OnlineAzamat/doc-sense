// Minimal Markdown -> HTML for assistant answers. No library, no build step.
// Everything is escaped first, so nothing the model writes can inject HTML.
(function (global) {
  function escapeHtml(text) {
    return text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function inline(text) {
    const codes = [];
    let out = escapeHtml(text).replace(/`([^`]+)`/g, (_, code) => {
      codes.push(code);
      return `@@CODE${codes.length - 1}@@`;
    });

    out = out.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
    out = out.replace(/(^|[\s(])\*([^*\n]+)\*(?=$|[\s).,:;!?])/g, "$1<em>$2</em>");
    // Links are shown as their label — the demo never navigates away.
    out = out.replace(/\[([^\]\n]+)\]\(([^)\n]+)\)/g, "$1");

    return out.replace(/@@CODE(\d+)@@/g, (_, i) => `<code>${codes[i]}</code>`);
  }

  const BULLET = /^\s*[-*•]\s+(.*)$/;
  const NUMBER = /^\s*\d+[.)]\s+(.*)$/;
  const HEADING = /^(#{1,4})\s+(.*)$/;
  const QUOTE = /^\s*>\s?(.*)$/;
  const RULE = /^\s*(-{3,}|\*{3,}|_{3,})\s*$/;
  const FENCE = /^\s*```/;

  function isTableRow(line) {
    return /^\s*\|.*\|\s*$/.test(line);
  }

  function isTableDivider(line) {
    return isTableRow(line) && /^[\s|:-]+$/.test(line);
  }

  function tableCells(line) {
    return line.trim().replace(/^\||\|$/g, "").split("|").map((cell) => cell.trim());
  }

  function startsBlock(line) {
    return (
      !line.trim() ||
      HEADING.test(line) ||
      BULLET.test(line) ||
      NUMBER.test(line) ||
      QUOTE.test(line) ||
      RULE.test(line) ||
      FENCE.test(line) ||
      isTableRow(line)
    );
  }

  function render(src) {
    const lines = String(src == null ? "" : src).replace(/\r\n?/g, "\n").split("\n");
    const html = [];
    let i = 0;

    while (i < lines.length) {
      const line = lines[i];

      if (!line.trim()) {
        i += 1;
      } else if (FENCE.test(line)) {
        const code = [];
        i += 1;
        while (i < lines.length && !FENCE.test(lines[i])) {
          code.push(escapeHtml(lines[i]));
          i += 1;
        }
        i += 1; // closing fence, or past the end while the answer is still streaming
        html.push(`<pre><code>${code.join("\n")}</code></pre>`);
      } else if (isTableRow(line) && isTableDivider(lines[i + 1] || "")) {
        const head = tableCells(line).map((c) => `<th>${inline(c)}</th>`).join("");
        const body = [];
        i += 2;
        while (i < lines.length && isTableRow(lines[i])) {
          body.push(`<tr>${tableCells(lines[i]).map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`);
          i += 1;
        }
        html.push(`<table><thead><tr>${head}</tr></thead><tbody>${body.join("")}</tbody></table>`);
      } else if (RULE.test(line)) {
        html.push("<hr />");
        i += 1;
      } else if (HEADING.test(line)) {
        const match = HEADING.exec(line);
        const level = Math.min(match[1].length + 2, 6);
        html.push(`<h${level}>${inline(match[2])}</h${level}>`);
        i += 1;
      } else if (QUOTE.test(line)) {
        const parts = [];
        while (i < lines.length && QUOTE.test(lines[i])) {
          parts.push(inline(QUOTE.exec(lines[i])[1]));
          i += 1;
        }
        html.push(`<blockquote>${parts.join("<br />")}</blockquote>`);
      } else if (BULLET.test(line) || NUMBER.test(line)) {
        const ordered = !BULLET.test(line);
        const pattern = ordered ? NUMBER : BULLET;
        const items = [];
        while (i < lines.length && pattern.test(lines[i]) && !RULE.test(lines[i])) {
          items.push(`<li>${inline(pattern.exec(lines[i])[1])}</li>`);
          i += 1;
        }
        const tag = ordered ? "ol" : "ul";
        html.push(`<${tag}>${items.join("")}</${tag}>`);
      } else {
        const parts = [inline(line)];
        i += 1;
        while (i < lines.length && !startsBlock(lines[i])) {
          parts.push(inline(lines[i]));
          i += 1;
        }
        html.push(`<p>${parts.join("<br />")}</p>`);
      }
    }

    return html.join("");
  }

  global.renderMarkdown = render;
})(window);

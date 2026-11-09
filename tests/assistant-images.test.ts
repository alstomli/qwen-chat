import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MessageMarkdown } from "../src/components/chat-workspace";
import config from "../next.config";

function render(content: string) {
  return renderToStaticMarkup(createElement(MessageMarkdown, {
    message: { id: "answer", role: "assistant", content },
  }));
}

test("assistant Markdown drops images before React can emit img or preload markup", () => {
  for (const source of ["https://tracker.invalid/pixel?private=answer", "//tracker.invalid/pixel", "/google-g.png", "data:image/png;base64,aA==", "blob:https://chat.invalid/id"]) {
    for (const markdown of [
      `Before ![inline](${source}) after`,
      `Before ![reference][pixel] after\n\n[pixel]: ${source}`,
      `Before [![linked](${source})](https://example.com) after`,
    ]) {
      // Every prefix is also a possible streamed render, including unfinished syntax.
      for (let length = 1; length <= markdown.length; length++) {
        const html = render(markdown.slice(0, length));
        assert.doesNotMatch(html, /<img\b|<link\b[^>]*\bas="image"/i, markdown);
      }
    }
  }
});

test("assistant text, links, GFM, code and escaped HTML remain available", () => {
  const html = render('**Useful text** [Documentation](https://example.com/docs)\n\n| A | B |\n| - | - |\n| one | two |\n\n```md\n![code](https://tracker.invalid/pixel)\n```\n\n<img src="https://tracker.invalid/raw">');
  assert.match(html, /<strong>Useful text<\/strong>/);
  assert.match(html, /href="https:\/\/example.com\/docs" target="_blank" rel="noopener noreferrer"/);
  assert.match(html, /<table>/);
  assert.match(html, /<pre><code class="language-md">!\[code\]/);
  assert.match(html, /aria-label="Copy code"/);
  assert.match(html, /&lt;img src=/);
  assert.doesNotMatch(html, /<img\b|<link\b[^>]*\bas="image"/i);
});

test("image CSP permits only local UI assets and user attachment URL schemes", async () => {
  const rules = await config.headers!();
  const global = rules.find(rule => rule.source === "/:path*");
  assert.equal(global?.headers.find(header => header.key === "Content-Security-Policy")?.value,
    "img-src 'self' data: blob:;");
});

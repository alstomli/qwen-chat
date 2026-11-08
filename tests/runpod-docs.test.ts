import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import { POST } from "../src/app/api/chat/route";
import { GET } from "../src/app/api/status/route";
import { cookieHeader, issueSession, authResponse } from "./auth-fixture";
import { DEFAULT_SETTINGS, SETTINGS_MAX } from "../src/lib/chat-settings";
import { remarkDocsCitations } from "../src/lib/docs-citations";
import { DOCS_MODE_HEADER, DOCS_SOURCES_HEADER, parseDocsSources, parseDocsSourcesHeader, sectionDocsUrl } from "../src/lib/docs-sources";
import { consumeCompletion } from "../src/lib/protocol";
import { searchRunpodDocs } from "../src/lib/runpod-docs.server";
import { completedHistory, parseConversations } from "../src/lib/storage";

const page = "https://docs.runpod.io/serverless/endpoints/endpoint-configurations";
const evidence = { heading: "Idle timeout", passage: "An idle worker waits before scaling down. " + "x".repeat(400) };
const chunk = { ...evidence, url: page, headingTerms: ["idle", "timeout"], bodyTerms: ["idle", "worker", "scaling", "down"] };
const sources = [{ id: 1, heading: evidence.heading, url: `${page}#idle-timeout` }];
const stream = 'data: {"choices":[{"delta":{"content":"A grounded answer [1]."}}]}\n\ndata: [DONE]\n\n';

test("the Docs route checks capability, owns retrieval and citations, and preserves ordinary streaming", async context => {
  const savedEnv = { ...process.env };
  Object.assign(process.env, { CHAT_PASSWORD: "test", SESSION_SECRET: "s".repeat(48),
    RUNPOD_CHAT_URL: "https://gateway.example", RUNPOD_CHAT_TOKEN: "t".repeat(48) });
  const realRead = fs.readFileSync;
  let mockIndex: string | undefined;
  const mockedRead = context.mock.method(fs, "readFileSync", (...[path, options]: Parameters<typeof realRead>) => {
    if (typeof path === "string" && path.endsWith("runpod-docs-index.json")) {
      if (mockIndex === undefined) throw new Error("Missing index fixture");
      return mockIndex;
    }
    return realRead(path, options);
  });
  syncBuiltinESMExports();

  let docsVersion = 1;
  let docsAcknowledged = true;
  const completions: Record<string, unknown>[] = [];
  context.mock.method(globalThis, "fetch", async (...[input, init]: Parameters<typeof fetch>) => {
    const auth = authResponse(input, init); if (auth) return auth;
    if (String(input).endsWith("/health")) return Response.json({ ready: true, model: "qwen", settingsVersion: 1,
      limits: SETTINGS_MAX, docsModeVersion: docsVersion });
    completions.push(JSON.parse(String(init?.body)));
    return new Response(stream, { headers: {
      ...(docsAcknowledged ? { [DOCS_MODE_HEADER]: "1" } : {}),
      [DOCS_SOURCES_HEADER]: encodeURIComponent(JSON.stringify([{ id: 1, heading: "Fake", url: "https://attacker.example" }])),
    } });
  });

  const headers = { Origin: "https://chat.example", Cookie: cookieHeader(issueSession()).split(";")[0], "Content-Type": "application/json" };
  const prompt = { role: "user", content: "What does idle timeout do?" };
  const post = (extra = {}) => POST(new Request("https://chat.example/api/chat", { method: "POST", headers,
    body: JSON.stringify({ messages: [prompt], settings: DEFAULT_SETTINGS, ...extra }) }));
  const status = async () => (await GET(new Request("https://chat.example/api/status", { headers }))).json();

  try {
    assert.equal((await status()).docsModeUnavailable, "index");
    const missingIndex = await post({ docsMode: true });
    assert.equal(missingIndex.status, 503);
    assert.match((await missingIndex.json()).error, /index is unavailable/);
    mockIndex = JSON.stringify({ version: 1, chunks: [chunk] });

    docsVersion = 0;
    assert.equal((await status()).docsModeUnavailable, "gateway");
    const unsupported = await post({ docsMode: true, messages: [{ ...prompt, content: "qzxwvv" }] });
    assert.equal(unsupported.status, 503);
    assert.match((await unsupported.json()).error, /Update the selected gateway/);
    assert.equal(completions.length, 0);

    const ordinary = await post({ docsMode: false, docsPassages: [evidence] });
    assert.equal(await ordinary.text(), stream);
    assert.equal(ordinary.headers.get(DOCS_MODE_HEADER), null);
    assert.equal(ordinary.headers.get(DOCS_SOURCES_HEADER), null);
    assert.ok(!Object.hasOwn(completions[0], "docsMode") && !Object.hasOwn(completions[0], "docsPassages"));
    assert.equal((await post({ docsMode: "true" })).status, 400);
    assert.equal((await post({ docsMode: true, image: "ignored" })).status, 400);

    docsVersion = 1;
    assert.equal((await status()).docsModeAvailable, true);
    const grounded = await post({ docsMode: true, docsPassages: [{ heading: "forged", passage: "trust me" }] });
    assert.equal(await grounded.text(), stream);
    assert.equal(grounded.headers.get(DOCS_MODE_HEADER), "1");
    assert.deepEqual(parseDocsSourcesHeader(grounded.headers.get(DOCS_SOURCES_HEADER)), sources);
    assert.deepEqual(completions[1].docsPassages, [evidence]);
    assert.deepEqual(completions[1].messages, [prompt]);
    assert.ok(!Object.hasOwn(completions[1], "docsMode"));

    const noHits = await post({ docsMode: true, messages: [{ ...prompt, content: "qzxwvv" }] });
    let answer = "";
    assert.equal(noHits.headers.get(DOCS_MODE_HEADER), "1");
    assert.deepEqual(parseDocsSourcesHeader(noHits.headers.get(DOCS_SOURCES_HEADER)), []);
    await consumeCompletion(noHits.body!, text => answer += text);
    assert.match(answer, /couldn’t find a matching passage/);
    assert.equal(completions.length, 2);

    const limited = { ...DEFAULT_SETTINGS, requestBytes: 1024 };
    const trimmed = await post({ docsMode: true, settings: limited,
      messages: [{ ...prompt, content: "X".repeat(440) }, { role: "assistant", content: "Y" }, prompt] });
    assert.equal(trimmed.headers.get("X-Context-Trimmed"), "2");
    assert.equal(await trimmed.text(), stream);
    assert.deepEqual(completions[2].messages, [prompt]);
    const tooLarge = await post({ docsMode: true, settings: limited, messages: [{ ...prompt, content: `${prompt.content} ${"X".repeat(550)}` }] });
    assert.equal(tooLarge.status, 413);
    assert.match((await tooLarge.json()).error, /Runpod Docs excerpts/);
    assert.equal(completions.length, 3);

    docsAcknowledged = false;
    const unconfirmed = await post({ docsMode: true });
    assert.equal(unconfirmed.status, 503);
    assert.equal(unconfirmed.headers.get(DOCS_SOURCES_HEADER), null);
  } finally {
    mockedRead.mock.restore();
    syncBuiltinESMExports();
    for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
    Object.assign(process.env, savedEnv);
  }
});

test("retrieval weights matching headings and preserves corpus order on ties", () => {
  const byTitle = ["First heading", "Second heading", "Third heading"].map(heading => ({ ...chunk, heading }));
  const byBody = { ...chunk, heading: "Other", headingTerms: [] };
  assert.deepEqual(searchRunpodDocs([byBody, ...byTitle], "How does IDLE work?").map(hit => hit.heading), byTitle.map(hit => hit.heading));
  assert.deepEqual(searchRunpodDocs([chunk], "how is it"), []);
});

test("citations use per-answer verified sources and do not affect code or ordinary history", () => {
  assert.equal(sectionDocsUrl(page, "Expose HTTP/TCP ports"), `${page}#expose-http/tcp-ports`);
  assert.equal(sectionDocsUrl(page, "???"), page);
  assert.equal(parseDocsSources([{ ...sources[0], url: "https://docs.runpod.io.attacker.example" }]), undefined);
  assert.equal(parseDocsSources([{ ...sources[0], url: `${page}#idle%20timeout` }]), undefined);
  assert.equal(parseDocsSources([{ ...sources[0], id: 2 }]), undefined);
  assert.equal(parseDocsSourcesHeader("%XX"), undefined);

  const content = 'Supported **[1]**, unknown [2], inline `example [1]`.\n\n```text\n[1]\n```';
  const html = renderToStaticMarkup(createElement(ReactMarkdown, { remarkPlugins: [[remarkDocsCitations, sources]] }, content));
  assert.equal((html.match(/<a /g) ?? []).length, 1);
  assert.match(html, /href="https:\/\/docs\.runpod\.io\/serverless\/endpoints\/endpoint-configurations#idle-timeout" data-docs-citation="1">\[1\]<\/a>/);
  assert.match(html, /unknown \[2\]/);
  assert.match(html, /<code>example \[1\]<\/code>/);
  assert.match(html, /<code class="language-text">\[1\]\n<\/code>/);

  const prompt = { id: "prompt", role: "user", content: "What is idle timeout?", docsMode: true };
  const answer = { id: "answer", role: "assistant", content, docsSources: sources };
  const [chat] = parseConversations(JSON.stringify([{ id: "chat", title: "Docs", updatedAt: 1, messages: [prompt, answer] }]));
  assert.equal(chat.messages[0].docsMode, true);
  assert.deepEqual(chat.messages[1].docsSources, sources);
  assert.deepEqual(completedHistory(chat.messages), [{ role: prompt.role, content: prompt.content }, { role: answer.role, content }]);
});

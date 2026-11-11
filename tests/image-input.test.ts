import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_SETTINGS, fitMessages, jsonBytes } from "../src/lib/chat-settings";
import { parseImageInputLimits } from "../src/lib/image-input";
import { validateInput } from "../src/lib/protocol";
import { completedHistory, parseConversations } from "../src/lib/storage";

const image = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jgZkAAAAASUVORK5CYII=";
const prompt = { role: "user", content: "Describe this image." } as const;

test("image input is a bounded inline image on the newest BF16 base prompt", () => {
  const request = { model: "bf16", useAdapter: false, messages: [prompt], image };
  assert.equal(validateInput(request).image, image);
  assert.throws(() => validateInput({ ...request, model: "4bit", useAdapter: undefined }), /supported/);
  assert.throws(() => validateInput({ ...request, useAdapter: true }), /Turn off.*trained adapter.*Advanced settings/);
  for (const invalid of ["https://example.com/image.png", image.replace("image/png", "image/jpeg"), image + "\n", [image, image]]) {
    assert.throws(() => validateInput({ ...request, image: invalid }), /image/);
  }
  assert.throws(() => validateInput({ ...request, image: image.replace("base64,", `base64,${"A".repeat(350000)}`) }), /byte limit/);
  assert.deepEqual(parseImageInputLimits({ maxBytes: 1000000, maxDimension: 4096, mimeTypes: ["image/png", "image/svg+xml"] }),
    { maxBytes: 262144, maxDimension: 2048, mimeTypes: ["image/png"] });
});

test("image bytes trim only whole text exchanges and attachment metadata stays out of history", () => {
  const messages = [
    { role: "user", content: "x".repeat(700) },
    { role: "assistant", content: "An earlier reply" },
    prompt,
  ];
  const settings = { ...DEFAULT_SETTINGS, requestBytes: 1200 };
  settings.requestBytes = jsonBytes({ model: "bf16", useAdapter: false, messages, max_tokens: settings.outputTokens,
    temperature: 0.7, settings, image, stream: true }) - 1;
  assert.deepEqual(fitMessages(messages, settings, 0.7, "bf16", false), messages);
  assert.deepEqual(fitMessages(messages, settings, 0.7, "bf16", false, image), [prompt]);
  assert.throws(() => validateInput({ model: "bf16", useAdapter: false, messages, settings, image }), /Request byte limit/);

  const [stored] = parseConversations(JSON.stringify([{ id: "chat", title: "Image prompt", updatedAt: 1, messages: [
    { id: "user", ...prompt, imageName: "Screenshot.png" },
    { id: "reply", role: "assistant", content: "An image description." },
  ] }]));
  assert.equal(stored.messages[0].imageName, "Screenshot.png");
  assert.deepEqual(completedHistory(stored.messages), [prompt, { role: "assistant", content: "An image description." }]);
});

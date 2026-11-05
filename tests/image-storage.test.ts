import assert from "node:assert/strict";
import { test } from "node:test";
import { completedHistory, parseConversations, serializeConversations, type Conversation } from "../src/lib/storage";

test("image turns round-trip in a format that preserves text history in older builds", () => {
  const conversation: Conversation = {
    id: "chat", title: "Mixed conversation", updatedAt: 1, model: "4bit",
    messages: [
      { id: "question", role: "user", content: "Text question" },
      { id: "picture", role: "image", content: "Private image prompt", state: "ready" },
      { id: "reply", role: "assistant", content: "Text reply", model: "4bit" },
      { id: "interrupted", role: "image", content: "Interrupted prompt", state: "queued" },
      { id: "generating", role: "image", content: "Current prompt", state: "generating", jobId: "current-handle" },
      { id: "retry", role: "image", content: "Recoverable prompt", state: "error", jobId: "retry-handle" },
    ],
  };
  const serialized = serializeConversations([conversation]);
  const [legacy] = JSON.parse(serialized);
  assert.ok(legacy.messages.every((message: { role: string; content: string }) =>
    ["user", "assistant"].includes(message.role) && typeof message.content === "string"));
  assert.equal(legacy.messages[1].content, "");
  assert.equal(legacy.messages[1].qwenImage.version, 1);
  const textHistory = [{ role: "user", content: "Text question" }, { role: "assistant", content: "Text reply" }];
  assert.deepEqual(completedHistory(legacy.messages), textHistory);

  const [restored] = parseConversations(serialized);
  assert.deepEqual(completedHistory(restored.messages), textHistory);
  assert.equal(restored.messages[1].role, "image");
  assert.equal(restored.messages[1].content, "Private image prompt");
  assert.equal(restored.messages[1].state, "ready");
  assert.equal(restored.messages[3].state, "error");
  assert.equal(restored.messages[4].role === "image" && restored.messages[4].jobId, "current-handle");
  assert.equal(restored.messages[5].role === "image" && restored.messages[5].jobId, "retry-handle");

  legacy.messages[1].qwenImage.content = null;
  const [withCorruptMetadata] = parseConversations(JSON.stringify([legacy]));
  assert.deepEqual(completedHistory(withCorruptMetadata.messages), textHistory);
});

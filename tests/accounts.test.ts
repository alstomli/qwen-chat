import { test } from "node:test";
import assert from "node:assert/strict";
import { requestAuthenticated } from "../src/lib/auth";
import { POST } from "../src/app/api/chat/route";
import { accountStorageKey } from "../src/lib/account-storage";
import { authResponse, cookieHeader, issueSession } from "./auth-fixture";

test("API requires server-confirmed Google identity and a live session, rejecting anonymous and legacy cookies", async () => {
  const savedEnv = { ...process.env }; const savedFetch = globalThis.fetch;
  try {
    const cookie = cookieHeader(issueSession());
    let confirmed = true, active = true, invalid = false, google = true, rpc = 0;
    globalThis.fetch = async (input, init) => {
      if (String(input).includes("/rpc/")) rpc++;
      const response = authResponse(input, init, { confirmed, active, invalid, google });
      if (!response) throw new Error("Unauthenticated request reached inference");
      return response;
    };
    const request = (Cookie = cookie) => new Request("https://chat.example/api/chat", { method: "POST", headers: { Cookie, Origin: "https://chat.example" }, body: JSON.stringify({ messages: [{ role: "user", content: "hello" }] }) });
    assert.equal(await requestAuthenticated(request()), true);
    for (const cookies of ["", "qwen_session=old.signed.cookie", "sb-fixture-auth-token=forged"]) assert.equal((await POST(request(cookies))).status, 401);
    confirmed = false; const before = rpc;
    assert.equal((await POST(request())).status, 401); assert.equal(rpc, before);
    confirmed = true; google = false;
    assert.equal((await POST(request())).status, 401); assert.equal(rpc, before);
    google = true; active = false;
    assert.equal((await POST(request())).status, 401);
    active = true; invalid = true;
    assert.equal((await POST(request())).status, 401);
    globalThis.fetch = async () => { throw new Error("Auth unavailable"); };
    assert.equal(await requestAuthenticated(request()), false);
  } finally { process.env = savedEnv; globalThis.fetch = savedFetch; }
});
test("account storage scopes chats/settings independently and never aliases anonymous keys", () => {
  for (const key of ["qwen-chat.conversations.v1", "qwen-chat.settings.v1", "qwen-chat.model-settings.v1"]) {
    assert.notEqual(accountStorageKey(key, "alice"), accountStorageKey(key, "bob"));
    assert.notEqual(accountStorageKey(key, "alice"), key);
    assert.throws(() => accountStorageKey(key, ""));
  }
});

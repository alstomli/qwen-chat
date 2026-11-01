import { test } from "node:test";
import assert from "node:assert/strict";
import { POST } from "../src/app/api/login/route";

process.env.CHAT_PASSWORD = "login-route-test-password";
process.env.SESSION_SECRET = "login-route-test-secret-" + "x".repeat(40);

let requestId = 0;
function login(value: unknown) {
  return POST(new Request("https://chat.example/api/login", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "https://chat.example", "x-forwarded-for": `login-route-test-${requestId++}` },
    body: JSON.stringify(value),
  }));
}

test("login rejects JSON values without a password object", async () => {
  for (const value of [null, [], "password", 123, true, {}, { other: "value" }]) {
    const response = await login(value);
    assert.equal(response.status, 400);
    assert.equal(response.headers.get("Set-Cookie"), null);
  }
});

test("login rejects invalid passwords and issues a session for valid credentials", async () => {
  for (const password of [null, 123, {}, [], "wrong", "x".repeat(257)]) {
    const response = await login({ password });
    assert.equal(response.status, 401);
    assert.equal(response.headers.get("Set-Cookie"), null);
  }
  const response = await login({ password: process.env.CHAT_PASSWORD });
  assert.equal(response.status, 200);
  assert.ok(response.headers.get("Set-Cookie"));
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { POST } from "../src/app/api/login/route";
test("legacy login never issues sessions and retains origin protection", async () => {
  for (const origin of ["https://chat.example", "https://evil.example"]) {
    const res = await POST(new Request("https://chat.example/api/login", { method: "POST", headers: { Origin: origin }, body: JSON.stringify({ password: "old-password" }) }));
    assert.equal(res.status, origin === "https://chat.example" ? 410 : 403);
    assert.equal(res.headers.get("Set-Cookie"), null);
  }
});

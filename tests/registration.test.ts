import { test } from "node:test";
import assert from "node:assert/strict";
import { registrationAvailable } from "../src/lib/registration";
import { GET } from "../src/app/api/registration/route";

test("capacity notice exposes only availability and treats RPC failure as unknown", async () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = { ...process.env };
  try {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://fixture.supabase.co";
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = "fixture-public-key";
    let value: unknown = { available: false, accounts: 100, privateData: "must not leave RPC boundary" };
    let status = 200;
    globalThis.fetch = async (input, init) => {
      assert.equal(String(input), "https://fixture.supabase.co/rest/v1/rpc/registration_capacity");
      assert.equal(init?.cache, "no-store");
      assert.ok(init?.signal);
      return Response.json(value, { status });
    };
    const response = await GET();
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    assert.deepEqual(await response.json(), { available: false });
    value = { available: true };
    assert.equal(await registrationAvailable(), true);
    for (const invalid of [null, {}, { available: "false" }, []]) {
      value = invalid;
      assert.equal(await registrationAvailable(), null);
    }
    status = 500; value = { message: "private database failure" };
    assert.deepEqual(await (await GET()).json(), { available: null });
    globalThis.fetch = async () => { throw new Error("Network unavailable"); };
    assert.equal(await registrationAvailable(), null);
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    assert.equal(await registrationAvailable(), null);
  } finally { globalThis.fetch = originalFetch; process.env = originalEnv; }
});

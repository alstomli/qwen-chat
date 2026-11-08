import { test } from "node:test";
import assert from "node:assert/strict";
import type { User } from "@supabase/supabase-js";
import { isVerifiedGoogleUser } from "../src/lib/google-user";
import { user } from "./auth-fixture";

test("Google access requires a provider-verified identity for the confirmed account email", () => {
  const candidate = structuredClone(user) as User;
  assert.equal(isVerifiedGoogleUser(candidate), true);
  candidate.identities![0].identity_data!.email = "TEST@EXAMPLE.COM";
  assert.equal(isVerifiedGoogleUser(candidate), true);
  for (const value of [false, undefined, "true", 1]) {
    candidate.identities![0].identity_data!.email_verified = value;
    assert.equal(isVerifiedGoogleUser(candidate), false);
  }
  candidate.identities![0].identity_data!.email_verified = true;
  candidate.identities![0].identity_data!.email = "other@example.com";
  assert.equal(isVerifiedGoogleUser(candidate), false);
  candidate.identities![0].identity_data!.email = "test@example.com";
  candidate.is_anonymous = true;
  assert.equal(isVerifiedGoogleUser(candidate), false);
  candidate.is_anonymous = false;
  candidate.email_confirmed_at = undefined;
  assert.equal(isVerifiedGoogleUser(candidate), false);
  candidate.email_confirmed_at = user.email_confirmed_at;
  candidate.identities = [];
  candidate.user_metadata = { provider: "google", email_verified: true };
  candidate.app_metadata = { provider: "google", providers: ["google"] };
  assert.equal(isVerifiedGoogleUser(candidate), false);
  assert.equal(isVerifiedGoogleUser(null), false);
});

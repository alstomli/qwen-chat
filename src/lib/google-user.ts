import type { User } from "@supabase/supabase-js";

// Call only with auth.getUser()'s remotely verified user. Editable user_metadata
// must never grant access, and a Google identity for another email is insufficient.
export function isVerifiedGoogleUser(user: User | null | undefined): user is User {
  return !!user?.email && !!user.email_confirmed_at && !user.is_anonymous
    && user.identities?.some(identity => identity.provider === "google"
      && identity.identity_data?.email_verified === true
      && typeof identity.identity_data.email === "string"
      && identity.identity_data.email.toLowerCase() === user.email!.toLowerCase()) === true;
}

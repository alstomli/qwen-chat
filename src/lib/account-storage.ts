// Legacy anonymous keys are intentionally never imported into a real account.
export function accountStorageKey(key: string, userId: string) {
  if (!userId) throw new Error("An account is required for saved conversations.");
  return `${key}:user:${encodeURIComponent(userId)}`;
}

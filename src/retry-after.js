// Retry-After is either seconds or an HTTP date. Missing is distinct from zero.
export function retryAfterMs(value, now = Date.now()) {
  if (!value?.trim()) return null;
  const delay = /^\d+$/.test(value.trim()) ? Number(value) * 1000 : Date.parse(value) - now;
  return Number.isFinite(delay) && delay >= 0 ? delay : null;
}

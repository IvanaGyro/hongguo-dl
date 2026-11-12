// SPDX-License-Identifier: GPL-3.0-only
// Cache a successful optional WASM availability check, but never cache a
// temporary 404, deployment race or failed HEAD request for the tab lifetime.
// Concurrent checks share one in-flight Promise.
export function retryableAvailability(check) {
  let pending = null;
  return () => {
    if (!pending) {
      pending = Promise.resolve().then(check).then(
        result => {
          if (!result) pending = null;
          return Boolean(result);
        },
        () => {
          pending = null;
          return false;
        }
      );
    }
    return pending;
  };
}

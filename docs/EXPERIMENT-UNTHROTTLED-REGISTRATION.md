# Registration-only rate-limit experiments

This branch changes **only the experimental Worker**; `main` and
the deployed Worker remain unchanged.

## Removed local scheduling and refusal latches

- `registrationRetryAfter` (10-second local registration failure cooldown).
- `retryAfter` / `refreshAfter` (unused cached-device retry and refresh cooldowns).
- `playbackQueue`, `playbackReadyAt` (one-by-one scheduling and 1-second delay).
- `playbackRejection` (sticky local upstream-refusal state).
- Empty-response retry **delays**, retaining bounded retry count and deadline.

## Preserved

- Upstream HTTP errors (including 403 and 429) and business-error classification.
- Per-request timeouts / cancellation and SSRF-safe host validation.
- Bounded response sizes and three-attempt limit for HTTP-200 empty source bodies.
- Signing and fresh device registration per source call.

The legacy `scripts/live-app-interval-bench.mjs` accepts `queue` and
`parallel` labels but both labels now use the same unthrottled execution
path; **do not** use it for an A/B comparison after this commit.
The prior experiment results remain available in GitHub Actions.
The workflow on this branch now performs **offline tests only**: it never
sends real registration traffic just because code was pushed.

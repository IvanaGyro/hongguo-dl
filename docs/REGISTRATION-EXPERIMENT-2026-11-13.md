# Real anonymous device registration: first live round (2026-11-13)

## Reproducibility

- Run: https://github.com/IvanaGyro/hongguo-dl/actions/runs/43442771327
- Code: `worker/registration-probe.js`, `scripts/live-registration-window.mjs`, `.github/workflows/registration-risk-live.yml`
- Exact setup: Cloudflare local `workerd` on GitHub Actions Linux runner; calls the **real** `/service/2/device_register/` upstream with the repository's existing encrypted anonymous registration request. **No media, player, CDN, source-query or simulated upstream calls.**
- No local request queue, retry-after latch, cooldown, device cache or automatic registration retries.
- The artifact `real-registration-window-timings` contains each request's send/completion timestamp relative to start, upstream HTTP code, internal registration category, request count, and latency. No IDs, signatures, tokens, response bodies, or signed URLs.
- All stages share one local worker isolate. 5 seconds minimum gap between separate trigger experiments, with longer wait periods in recovery tests.

## Observations

| Stage | Requests | Success | Failure | Upstream HTTP codes |
| --- | ---: | ---: | ---: | --- |
| A: 10-second intervals, baseline | 8 | 8 | 0 | 200 for all |
| B: 1-second intervals, 150 attempts | 150 | 109 | 41 | 200 for all |
| D: ongoing recovery probes | 6 | 1 | 5 | 200 for all |
| E: 1-second intervals, second trigger | 150 | 108 | 42 | 200 for all |
| E: one probe after 120s complete silence | 1 | 0 | 1 | 200 |
| **Total** | **315** | **226** | **89** | **200 for all** |

**All 89 failures were classified as `INVALID_RESPONSE`.** In the current implementation this means the parsed HTTP 200 registration reply did not yield acceptable device and installation IDs, **not** that an HTTP 403/429 was observed. This could be a risk response or a client validation/parsing issue; the present data cannot distinguish them.

### First 150-request trigger (B)

- First failure was request **100** within B; including 8 prior baseline successes, there were **107 successes** before the first failure.
- B requests 1–99: success.
- B requests 100–109: failure.
- B requests 110–119: success.
- B requests 120–150: failure.
- All requests each made exactly one upstream HTTP request.
- Median success latency 444 ms; median failure latency 351 ms.

### Recovery with active probing (D)

After B's final request completed, the subsequent probes were sent approximately:

| Time after B completion | Result |
| ---: | --- |
| 10 s | INVALID_RESPONSE |
| 20 s | INVALID_RESPONSE |
| 35 s | INVALID_RESPONSE |
| 65 s | INVALID_RESPONSE |
| 125 s | INVALID_RESPONSE |
| 305 s | success |

The scheduled offsets were 5, 15, 30, 60, 120, 300 seconds **after an initial additional 5-second rest**. This distinction matters when estimating cooldown length. An intermediate probe could itself affect the upstream timer.

### Second trigger and silent recovery (E)

- After the successful D probe, waited 5 seconds and sent another 150 requests at 1 second intervals.
- Requests 1–108: success.
- Requests 109–150: INVALID_RESPONSE.
- Waited until **120 seconds after the second trigger group's final completion**, issued exactly one probe. Result: INVALID_RESPONSE.
- This suggests at least 120 seconds of unsuccessful state after the last request, but cannot prove whether failure is a fixed ban, quota exhaustion, or missing identifier fields.

## Interpretation and necessary follow-up

1. No upstream HTTP 403 or 429, no request timeouts, no HTTP-200 empty bodies in these 315 attempts. The apparent rejection occurred *within* HTTP-200 JSON data.
2. Both bursts first experienced failure after roughly 100–110 successful registrations, but their earlier stages and prior load histories differed; this is **not** a proved fixed threshold.
3. B's ten failures, ten successes, then sustained failures suggest something more complex than a simple permanent ban.
4. Need a **safe, redacted structural diagnosis** of rejected HTTP 200 JSON: check only known status/code fields and whether `device_id_str`, `install_id_str`, numeric `device_id` / `install_id` are present, their types, and whether they validate. Do not log actual identifiers or arbitrary response body.
5. Stage C (different fixed intervals) is **not yet performed**. The first round specifically prioritizes the anomaly threshold and active versus silent recovery. Further cooldown bounds need independent triggers with different silent intervals, not repeated probes within E.
6. GitHub Actions runner IP and geographic routing may affect service-side enforcement. Current results describe this runner's conditions only.

This markdown records completed observations, **not** a claim that the backend's anti-abuse policy was identified.

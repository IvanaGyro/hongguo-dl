# Anonymous registration: live interval comparison (2026-11-13)

This document records **real upstream registration** experiments, not a simulated service. Workerd is local to GitHub Actions. No device-registration cooldown, local queue, or sticky refusal remains in this experimental branch.

| Rate | Baseline | Burst sends | Successes in burst | First zero ID | Zero IDs in burst | Recovered during burst? | Run |
| --- | ---: | ---: | ---: | --- | ---: | --- | --- |
| 1 s between sends | 3 successful | 150 | 117 | Burst #118 (cumulative #121) | 33 | No | [ID diagnostic](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43447596179) |
| 2 s between sends | 3 successful | 150 | 141 | Burst #118 (cumulative #121) | 9 | Yes, burst #127 | [C2](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43450890848) |

Each accepted ID was valid (both device_id and install_id > 0); each observed rejection yielded HTTP 200 with all four fields exactly zero:
`device_id=0`, `device_id_str="0"`, `install_id=0`, `install_id_str="0"`.
In both comparative runs, there were **exactly 120 successful registrations before the first zero-ID response** (baseline + burst). This is evidence for some kind of count quota, not proof of a specific quota implementation; different GitHub runner IPs and prior traffic remain confounds.

## Exact C2 boundary timings (UTC)

- Baseline first success: 2026-11-13 15:16:25.
- C2 burst #117 (120th successful registration): 15:20:42.
- C2 burst #118 (first zero ID): 15:20:44.
- Burst #118–126 (nine consecutive zero ID): 15:20:44–15:21:00.
- Burst #127 (first recovery): **15:21:02**.
- Burst #127–150: all succeeded.
- First active-recovery probe after 5-second inter-group rest + 5-second scheduled checkpoint: succeeded.

This timing is consistent with a time-dependent quota refresh near the minute boundary; does not establish whether the window is calendar-aligned, sliding, or affected by a reset elsewhere in the registration infrastructure.

## Earlier 315-registration run

[Original 315-request study](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43442771327) included 8 baseline successes, a 150-request burst at 1s spacing, repeated probing, and a further 150-request burst:

- Zero-ID interval 14:29:50–14:29:59 UTC.
- Successful interval began **14:30:00 UTC**, and only ten further registrations succeeded before new zero-ID responses began at 14:30:10.
- Recovery probe was unsuccessful through roughly 125s after the burst; successful at roughly 305s.
- After a second trigger, one quiet probe 120s later was still a zero-ID response.

These observations suggest timing- and count-dependent controls may coexist; distinguish actual registration responses from worker-local errors (none of the current experimental branch's local latches remain).

## Still unknown

- Whether the observed 120-success quota is globally stable or affected by the runner egress IP / prior requests.
- Exact window width, offset, replenishment and whether rejected registrations extend the restriction.
- Whether a longer silent interval reliably recovers registration.
- The effect of 5-second spacing (test is pending).
- Server response includes `server_time`, but current diagnostics capture only its presence, not the value.

## Additional 5-second run and overlapping diagnostic

- [C5: 150 registrations at 5-second intervals](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43452139626): three successful 10-second-spaced baseline requests followed by 150/150 success. **No zero-ID responses**. The complete experiment finished 770.970 seconds after script start.
- [Unintended overlapping 1-second diagnostic](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43453602608): an update to the shared probe file triggered an existing GitHub Actions workflow without the intended isolation. This ran in a separate GitHub runner **while C5 was active**. The diagnostic completed 3/3 baseline and 143/150 burst successes, with 7 zero-ID responses. The **118th burst request** was the first zero-ID; accounting for the baseline, it was the 121st registration, again matching the 120-success quota observation.
- In the overlapping diagnostic, zero IDs were observed between **15:34:53 and 15:34:59 UTC**, with success returning at **15:35:00 UTC** exactly on a minute boundary. This independently resembles C2's first recovery at 15:21:02 UTC and the older 14:30:00 UTC recovery.
- Overlap is a methodological flaw: because separate runners may have distinct outbound IPs, it does not prove global independence of limits. C5's 150/150 success is real but should be interpreted as an observed outcome, **not a perfectly isolated control**.

## Current 1s / 2s / 5s comparison

| Interval | Burst count | Burst success | Zero IDs | First zero ID | Returned to success during burst |
| --- | ---: | ---: | ---: | --- | --- |
| 1s (initial ID diagnostic) | 150 | 117 | 33 | #118 | no |
| 1s (overlapping diagnostic) | 150 | 143 | 7 | #118 | #125, around 15:35:00 UTC |
| 2s | 150 | 141 | 9 | #118 | #127, around 15:21:00 UTC |
| 5s | 150 | 150 | 0 | none | not applicable |

All three runs showing zero IDs at burst #118 had exactly 3 successful baseline requests preceding the 150-request burst. These repeated results strengthen the **120 successful-registration count** hypothesis. The *shape* and *duration* of the zero-ID intervals, however, depend on elapsed time relative to apparent boundary resets, and may involve several overlapping quotas. Current experiments cannot establish a precise window length, enforcement key, or whether failed attempts extend cooldown.

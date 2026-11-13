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

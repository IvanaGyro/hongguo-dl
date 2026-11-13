# Lossless anonymous registration ID diagnostic (2026-11-13)

## Execution

- [GitHub Actions run #43447596179](https://github.com/IvanaGyro/hongguo-dl/actions/runs/43447596179), succeeded
- Code: `worker/registration-id-probe.js`, `scripts/live-registration-id-diagnostic.mjs`, `.github/workflows/registration-id-diagnostic.yml`
- Local Cloudflare `workerd`; REAL registration upstream; no media/source/CDN requests.
- Experimental branch only. All per-request ID values were stored in the `registration-id-raw-diagnostic` ZIP artifact, **not stdout**; GitHub artifact retention was set to 1 day. Treat the ZIP as sensitive: it contains exact anonymous device IDs. Do not commit it to the repository.

## Results

- 153 registration requests in total: 3 baseline attempts at 10-second spacing, then a 5-second break, then 150 attempts at 1-second spacing.
- 120 successful, 33 invalid registration responses.
- 153/153 upstream responses were HTTP 200; no 403/429.
- In the 150-request group, the first 117 succeeded, requests **118–150** returned invalid IDs. The first failure was **request 121 overall**.
- Every failed HTTP 200 response contained all four ID fields, all **exactly zero**:
  - `device_id: 0`
  - `device_id_str: "0"`
  - `install_id: 0`
  - `install_id_str: "0"`
- Every successful response had 14–16 decimal digits in its `device_id_str` and `install_id_str`; the corresponding numeric forms matched their string counterparts exactly.
- In all 120 successful responses, the numeric forms were within JavaScript's safe-integer range. No observed precision change in any recorded ID.
- All 153 responses contained top-level keys `server_time`, `device_id`, `install_id`, `new_user`, `device_id_str`, `install_id_str`. No `code` or `Code` key was observed.

## Interpretation

The 33 invalid-registration cases were **not caused by ID parsing or an overly strict validator**: the upstream itself returned zero-valued IDs. This matches deliberate non-issuance, which may be a server-side control, but the test alone does not establish its policy or whether it is quota-, time-window-, or cooldown-based.

The experimental registration probe intentionally performs no extra retry, has no local cooldown or queue, and never records full upstream JSON, signatures, or credentials. The diagnostic response stores only four ID fields plus minimal status/type metadata.

Next measurements should keep the ID-level classification, separately study recovery times and change request intervals, and report elapsed time and cumulative attempts at every first zero-ID response.

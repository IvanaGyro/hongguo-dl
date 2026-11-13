# Explicit triggers for real-upstream experiments

The experimental workflows registered on this branch no longer run automatically
when source code, test harnesses, or workflow YAML files are edited.

To run one on `experiment/app-isolate-queue-probe-20261113`, make a commit
creating or changing the matching trigger file:

- `registration-id-diagnostic.txt`
- `registration-risk-live.txt`
- `registration-policy-c2.txt`
- `registration-policy-c5.txt`
- `registration-policy-e240.txt`

Use a unique short text such as the reason and current date in that one file.
The scripts make real HTTP requests to a third-party registration endpoint.
Do not trigger multiple live workflows simultaneously if the goal is to
observe isolation, cooldowns, or time windows.

The workerd probe itself remains local; no production Worker deployment occurs.

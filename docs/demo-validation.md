# What was actually checked

[Demo walkthrough](../examples/README.md) · [中文演示](../examples/README.zh-CN.md) · [Branch walkthrough](experiments.md)

These checks were run on 2026-11-16 with the repository's synthetic data. They establish behavior for these examples, not a production accuracy or performance guarantee.

| Check | Observed result |
| --- | --- |
| Local demo lifecycle | Start, repeated start, both drift scenarios, verification, reset, stop and resume preserved the documented stages. |
| Interrupted first setup | An injected Docker launch failure retained its original setup. Retrying started real PostgreSQL and verified both datasets. |
| Separate checkout | A second checkout's stop command was refused before changing the active demo. |
| Automated checks | Type checking, build and 23 base tests passed; all 7 real PostgreSQL integration tests passed, including both new datasets. |
| DSH discovery | An ordinary chat found and saved the telemetry relationships, then counted all 5 active events. |
| DSH reuse | A new chat reused the same saved relationship IDs, rechecked them and returned North 110 / South 40. |
| DSH changed data | After drift, another chat retained all 5 events / 150 units, including the unattributed event / 20 units. The panel linked the old validation and failed metric-scope check. |
| Answer wording | The first changed-data answer mixed up “no duplicate matches” with “the relationship passed”. After clarifying the bundled Skill, a fourth new chat explicitly said the first relationship failed complete coverage. Model wording still needs evidence-based review. |

The [panel captures](../examples/README.md#2-change-the-data-and-catch-stale-memory) come from those actual conversations. No expected SQL or relationship IDs were supplied to the Agent's discovery prompt. The deterministic dataset and branch runners are separate checks; their SQL is supplied by the manifests.

## Branch execution and recovery

Both Stello comparisons verified one shared baseline, separate work branches and session access, A/B isolation, the expected results and unchanged source fingerprints. They completed **after explicit recovery**, rather than passing on the first unattended attempt:

- One branch request returned an unknown timeout. Observing the original request later confirmed the exact branch identity; the new `reconcile` and `cleanup` commands collected that incomplete run without replaying creation.
- A later B write failed during transaction preparation. A read confirmed B still matched the baseline before an explicit new invocation submitted the update. The failed execution and recovery evidence were retained alongside the successful comparison.
- The support example's B branch request also timed out. Its original identity was observed and the same task resumed, without creating another branch. A assigned 390 minutes against General's 300-minute budget; B assigned 300 to General and 290 to Specialist. Both retained all 6 tickets / 590 minutes, and B did not alter the saved A result.

These observations do not establish the underlying cause of the Stello delays or a fix for them. Unknown writes remain unresolved until their original receipts establish an outcome. A permission error is not evidence that a remote resource has disappeared.

The fixture used a private Stello installation copy and its own containers. It did not build or run in the shared Stello checkout. Neon cloud execution was not run; the published API tests and opt-in cloud commands remain distinct from real cloud validation.

# Support workload: where should an unrouted ticket go?

This fully synthetic dataset demonstrates a workload decision. It uses the same general query, memory and branch capabilities as the telemetry example, with a different business question. Start with the [demo guide](../../README.md).

There are seven tickets and two team queues. Six tickets are open. The queue hint is an intake routing tag; verify its correspondence to the queue directory before grouping records. Closed tickets do not consume capacity in this example.

`estimated_minutes` is a toy effort estimate. General has 300 available minutes and Specialist has 480 in the planning window. These values are supplied business assumptions, not service-level guarantees or measured handling times.

| Stage | General planned work | Specialist planned work | Unassigned work | Total open work |
| --- | --- | --- | --- | --- |
| Initial data | 3 tickets / 270 min | 3 / 200 | 0 / 0 | 6 / 470 |
| After drift | 2 / 300 | 3 / 200 | 1 / 90 | 6 / 590 |
| Alternative A | 3 / 390 | 3 / 200 | 0 / 0 | 6 / 590 |
| Alternative B | 2 / 300 | 4 / 290 | 0 / 0 | 6 / 590 |

`drift.sql` raises ticket 1's estimate from 120 to 240 minutes and changes ticket 2's routing tag to `unrouted`. The first change affects the total workload. The second invalidates complete queue coverage. The legacy inner-join view omits the unassigned 90 minutes, so it cannot establish that all work is accounted for.

Create both alternatives from this same drifted baseline:

- **A: route ticket 2 to General.** General needs 390 minutes against a capacity of 300, an excess of 90.
- **B: route ticket 2 to Specialist.** General needs 300/300 minutes and Specialist needs 290/480. Both fit the supplied budgets.

Alternative B is preferable under this toy capacity constraint. That conclusion does not establish whether Specialist is qualified for the ticket or whether customer waiting time will improve. Those are separate business questions. Neither alternative should modify the source database through Stellane.

`setup.sql`, `drift.sql`, `variant-a.sql` and `variant-b.sql` are inspectable inputs. `manifest.json` holds expected rows and independent workload, capacity and whole-dataset fingerprint queries. The two variants each contain one update, ready for separate experiment branches. Expected results are for validation, not a prewritten Agent answer.

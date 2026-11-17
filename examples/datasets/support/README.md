# Support workload test fixture

This synthetic fixture checks workload totals, relationship coverage and branch isolation. For the first DSH walkthrough, start with the [telemetry demo](../../README.md).

Six of the seven tickets are open. The queue hint has no foreign key to the two-row queue directory. Only open tickets count toward workload.

`estimated_minutes` is a synthetic estimate. General and Specialist have capacities of 300 and 480 minutes respectively.

| Stage | General planned work | Specialist planned work | Unassigned work | Total open work |
| --- | --- | --- | --- | --- |
| Initial data | 3 tickets / 270 min | 3 / 200 | 0 / 0 | 6 / 470 |
| After drift | 2 / 300 | 3 / 200 | 1 / 90 | 6 / 590 |
| Alternative A | 3 / 390 | 3 / 200 | 0 / 0 | 6 / 590 |
| Alternative B | 2 / 300 | 4 / 290 | 0 / 0 | 6 / 590 |

`drift.sql` raises ticket 1's estimate from 120 to 240 minutes and sets ticket 2's routing tag to `unrouted`. The inner-join view drops the unassigned 90 minutes. `variant-a.sql` assigns ticket 2 to General, which exceeds its capacity by 90 minutes. `variant-b.sql` assigns it to Specialist, keeping both queues within capacity.

A read-only query is sufficient to compare these workload totals. The two update files give testers a predictable way to check isolation from a common starting point. `manifest.json` contains expected rows and independent queries for workload, capacity and the source fingerprint.

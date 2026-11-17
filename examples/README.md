# Try Stellane with synthetic data

These demos answer three practical questions: can the Agent understand an unfamiliar database, can a later chat reuse what it learned without trusting stale data, and can you compare changes from the same starting point?

Everything here is synthetic. The datasets are ordinary PostgreSQL tables, comments and views. No example table name is built into Stellane's product logic.

[中文演示指南](README.zh-CN.md) · [Installation](../README.md#install-stellane) · [Multiple experiment paths](../docs/experiments.md)

## Pick a starting point

| Demo | What you learn | Required connection |
| --- | --- | --- |
| 1. Discover and remember | Find implicit joins, save verified observations, reuse them in a new chat | PostgreSQL or Neon URL |
| 2. Catch a broken relationship | Recheck live data, retain unmatched rows, trace why old memory stopped applying | PostgreSQL or Neon URL |
| 3. Compare two repairs | Try two mappings from one baseline; understand why full coverage alone cannot choose the correct one | Stello |
| 4. Compare workload policies | Simulate two routing decisions and compare each against an explicit capacity budget | Stello |

Start with demos 1 and 2. Demos 3 and 4 show why Stellane has multiple experiment paths. [The branch guide](../docs/experiments.md) covers their setup, prompts, expected results and cleanup.

## Prepare a local playground

Install Stellane following the main README. Run these commands on the same machine as the Harness Host, with Docker available. No source checkout is needed for these analysis and memory demos. From a source checkout you may replace `dsh plugin --profile web exec stellane-demo` with `corepack pnpm demo` throughout.

```sh
dsh plugin --profile web exec stellane-demo start
dsh plugin --profile web exec stellane-demo url
```

The helper creates its own PostgreSQL 17 container, a read-only database user, both datasets and a project directory. It binds a random port on `127.0.0.1`. It does not use your normal development database.

1. Copy the URL printed by `demo url`.
2. In DSH, open **Stellane → Data sources → Add data source**, select PostgreSQL and paste the URL.
3. Set the project to the absolute path printed by `demo start`, normally **`~/.local/share/stellane-demo/project`** for an installed package. You can name the connection `Stellane demo`.
4. Click **Connect and start**.
5. Click **Ask in project chat** on the connection card to open a normal chat in the correct project. For later chats, hover over that project in the Harness workspace sidebar and click its new-chat button. You can keep using chat throughout the exercises.

`demo start` preserves existing data on subsequent runs. Connection files and local passwords are generated under `~/.local/share/stellane-demo/` for the package, or the Git-ignored `.stellane-dev/demo/` in a source checkout. An absolute `STELLANE_DEMO_HOME` overrides either location. To inspect or stop the playground:

```sh
dsh plugin --profile web exec stellane-demo status
dsh plugin --profile web exec stellane-demo verify
dsh plugin --profile web exec stellane-demo stop
```

`stop` retains the database volume. Run `start` to resume. `reset` restores only the two demo schemas and changes their object identities; old Stellane observations must then be validated again.

```sh
dsh plugin --profile web exec stellane-demo reset
```

## 1. Discover relationships, then use them in a new chat

Use the **telemetry** dataset. It contains an event log, device inventory and area registry, without foreign keys. Comments explain the meaning of each table. One event is inactive and must not be counted.

First chat:

> Use the Stellane demo database, schema `stellane_demo_telemetry`. Count active events by area. Investigate how the tables relate, check that all active events are included, and remember the relationships that the data supports.

Expected answer:

| Area | Active events |
| --- | ---: |
| North | 4 |
| South | 1 |
| **Total** | **5** |

Open **Data catalog → Relationships and lineage**. Look for the two relationships connecting events to devices and devices to areas, with actual validation evidence. The existing `active_event_totals` view also has catalog-derived lineage. Those are different sources of knowledge: a catalog dependency and a data-checked observation.

Start a **new normal chat in the same project**:

> Using what we learned about `stellane_demo_telemetry`, report the sum of magnitude by area for active events. Verify that the saved relationships still apply.

Expected sums are **North 110, South 40, total 150**. The Agent should retrieve the saved relationships and check live data before relying on them. It may run different exploratory SQL; correctness, evidence and appropriate reuse matter more than a fixed number of tool calls.

**Where this helps:** repeated questions about a database whose relationships are poorly documented. Users can ask a new question without describing the schema again. Memory provides a starting point; the current data still decides whether it is usable.

## 2. Change the data and catch stale memory

Keep the connection and saved memories. In a terminal, change one synthetic event's device reference:

```sh
dsh plugin --profile web exec stellane-demo drift telemetry
```

Open another new chat and ask:

> Report active event counts and magnitude totals by area in `stellane_demo_telemetry`, including any records that cannot be attributed.

Expected result:

| Area | Active events | Magnitude |
| --- | ---: | ---: |
| North | 3 | 90 |
| South | 1 | 40 |
| Unattributed | 1 | 20 |
| **Total** | **5** | **150** |

The total must remain 150. The old inner-join view now returns only 130 because it drops the unmatched event. This is a useful demonstration of why a successful query can still answer the wrong question.

Click **View metric evidence** under the answer. Check the population, filter, unmatched count and SQL. In **Data catalog → Relationships and lineage**, expand **History and invalidated observations**, then open the old relationship. It should show its original validation and the failed recheck, with an explanation. A metric-scope check must be labeled with that scope; its counts are not a fresh whole-table profile.

These are actual panel captures from the synthetic DSH walkthrough. The first keeps the unmatched record in the total; the second links the original validation to the check that invalidated it. These earlier captures use Chinese; the current panel also has an English language selector.

![Metric evidence retains the unmatched event and its 20 units](../docs/images/missing-record-evidence.png)

![The saved relationship shows its old validation and the failed metric-scope check](../docs/images/why-memory-expired.png)

Independently verify the published expectation:

```sh
dsh plugin --profile web exec stellane-demo verify telemetry
```

**Where this helps:** live data sources, late-arriving mappings, incomplete reference data and reports that silently drop rows. Stellane checks at use time; it does not continuously monitor every external write.

## 3. Follow two repair paths from the same baseline

The unmatched event has magnitude 20. Suppose the user wants to investigate two hypotheses:

- **A:** the event came from `device-a`, which belongs to North.
- **B:** the event came from `device-c`, which belongs to South.

Both restore complete coverage and preserve five events / 150 units. They produce different regional totals. Passing the join check does not establish which hypothesis is true.

Run these on Stello using the [multiple-path guide](../docs/experiments.md). Save the starting point once, use it for both experiments, retain both results, and inspect the difference before applying a real-world decision. The local PostgreSQL playground demonstrates discovery and memory; it does not acquire branching capability by installing the plugin.

## 4. Apply the same method to another business problem

The **support** dataset contains open tickets, estimated effort and two team queues. It uses a different relationship shape and a stated capacity budget. Follow its [dataset notes](datasets/support/README.md), then introduce the changed workload:

```sh
dsh plugin --profile web exec stellane-demo drift support
dsh plugin --profile web exec stellane-demo verify support
```

The changed population contains **six open tickets / 590 estimated minutes**, including **one unassigned ticket / 90 minutes**. On a branching provider, compare:

| Plan | General workload / capacity | Specialist workload / capacity | What the example establishes |
| --- | ---: | ---: | --- |
| A: assign the unassigned ticket to General | 390 / 300 | 200 / 480 | General exceeds the given budget by 90 minutes |
| B: assign it to Specialist | 300 / 300 | 290 / 480 | Both fit the given budgets |

This comparison does not prove that the Specialist team is qualified for that ticket or that waiting time will improve. Those need further business evidence. It illustrates a repeatable workflow: state the assumptions, branch, measure both choices, compare against a decision criterion.

## Files you can inspect and adapt

Each [dataset directory](datasets/) contains:

| File | Purpose |
| --- | --- |
| `setup.sql` | Create and explain the synthetic tables and view; fails if the schema exists |
| `drift.sql` | Introduce the documented changed state |
| `variant-a.sql`, `variant-b.sql` | One explicit modification per experiment path |
| `manifest.json` | Independent checking SQL, literal expected results, scope and interpretation |
| `README.md` | Schema, stage-by-stage numbers and limits of the conclusions |

The manifests are for reproducibility and independent verification. The ordinary-chat prompts ask the Agent to investigate; do not paste the expected SQL or relationship IDs into its discovery conversation.

For a dedicated PostgreSQL database without Docker, use `psql` to load the chosen `setup.sql`, grant your analysis role `USAGE` on that schema and `SELECT` on its tables, then connect its URL. The [branch guide](../docs/experiments.md#prepare-a-dedicated-demo-source) shows the equivalent setup for an experiment source. The helper's drift/reset commands only operate on its own local container; use the published SQL explicitly on other demo sources.

## If something does not match

- **First Docker startup failed:** fix the reported Docker problem and run `demo start` again; incomplete setup keeps its original credentials and volume. Use the same demo state directory (`STELLANE_DEMO_HOME` if set); do not adopt another demo’s resources.
- **No database found in chat:** confirm the connection and chat use the same absolute project directory.
- **Different counts:** run `demo status` and `demo verify`; a previous exercise may have left the dataset in the drifted state. Use `reset` for a new discovery exercise.
- **No saved relationships:** ask the Agent to investigate and remember the supported joins, then inspect the validation records. SQL output alone is not a saved memory.
- **A query fails:** inspect its error and scope in **Activity and results**. A failed query is not evidence that a relationship holds.
- **No branch action:** ordinary PostgreSQL and a Neon URL without API access support analysis and memory. Connect [local Neon in Docker](../docs/local-neon.md) or Stello for the multiple-path exercises.

Automated dataset verification uses `pnpm test:demo` after `pnpm dev:db`; it checks the published data and Core behavior on real PostgreSQL. `pnpm demo:branches` exercises real provider branches. A deterministic runner and an actual Agent conversation are reported separately. See [development and testing](../DEVELOPMENT.md).

See [release verification](../docs/release-status.md) for tested workflows.

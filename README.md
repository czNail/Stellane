# Stellane

Stellane is a DeepSeek Harness plugin for investigating PostgreSQL in ordinary chat. Find which data represents a business object and how its tables fit together. With Stello, apply proposed changes on isolated branches and inspect the results before deciding what to do.

[中文](README.zh-CN.md) · [Work through a missing relationship](examples/README.md) · [Rehearse a data repair](docs/experiments.md)

## Find the refund records once, then ask about refunds again

A user asks, “Which channels did last month's refunds come from?” The tables are called `t_037` and `t_058`, the columns `c01` and `c12`, and there are no foreign keys. Given two known refund references, the agent can look for candidate tables, verify which columns link to orders, and check whether the join would count any refund twice.

Once someone confirms which rows count as refunds, save the tables, fields and filters as a **business definition**. The agent can save the joins it verifies. When you ask, “Which channel had the most refunds this month?”, a later chat on the same source can pick up from both records and recheck the joins. When a report drops rows, view lineage shows where to investigate and query evidence shows what went missing. [Try the PostgreSQL walkthrough](examples/README.md).

## Rehearse a duplicate-order repair before adopting it

There are duplicate historical orders. Should you keep the newest record or the one that reconciles with a payment? A read-only query can show which rows each rule would pick. A rehearsal also needs to update order references and let the existing reports query the changed data.

With Stello, save one starting point and apply each proposal on its own branch. Run the same checks for payment and refund amounts, missing references and changes to channel totals. Keep the edits and results for review. [See the branch rehearsal](docs/experiments.md).

## Install and ask a question

Use Node.js **24.9+**, DeepSeek Harness Web **0.2.2-rc.1 through rc.3**, and a working DSH model connection. Installation was tested on Linux.

In DSH, open **Plugins → Add plugin** and enter `stellane`, or run:

```sh
dsh plugin --profile web add stellane
```

1. Restart the Web Host. Open **Stellane → Data sources → Add data source**.
2. Choose **PostgreSQL**, paste the connection URL, select your project directory and click **Connect and start**. A regular Neon PostgreSQL URL works here too.
3. Click **Ask in project chat**, or open an ordinary DSH chat in that project. Ask:

> Which data contains refunds? How do those records link back to orders? Show me what you checked.

Use **Data catalog → Relationships and lineage** for view dependencies and verified joins. Open **Activity and results** for SQL, experiment progress and saved results.

In 0.1, the agent can read saved business definitions and retain verified keys and equality joins. Automatically saving newly discovered business terms and their mappings is a design goal. Lineage covers upstream dependencies of PostgreSQL views. Stello branching has been verified. Local and cloud Neon branching remain experimental.

[Install, upgrade and remove](docs/install-and-maintain.md) · [Data and privacy](docs/data-and-privacy.md) · [Development and testing](DEVELOPMENT.md)

# Stellane

**Ask questions about your Postgres data in a normal DeepSeek Harness chat. Keep the evidence and reuse what the Agent learns.**

Stellane is a DeepSeek Harness plugin. It gives the Agent access to your database's tables, definitions and relationships, saves verified discoveries, and checks them again when the data can change. The side panel shows the SQL, sources, saved relationships and experiment results behind an answer.

[中文说明](README.zh-CN.md) · [Product decisions](PRODUCT.md) · [Development and testing](DEVELOPMENT.md)

## What it helps with

- **Understand unfamiliar data.** Read table and column descriptions, declared relationships and view dependencies. Add business definitions when names alone are not enough.
- **Avoid rediscovering the same joins.** The Agent proposes a key or relationship; Stellane checks the data before saving it. A later chat can find that observation and recheck it before use. Failed checks preserve the old and new evidence.
- **Explain an answer.** Open the recorded SQL and data scope from the conversation. Supported cross-table metrics include totals, relationship coverage and unattributed records.
- **Try a change in isolation.** With Neon branching or Stello, ask for an experiment. The Agent works on its own branch, records the result and ends the experiment without changing the source through Stellane.

These features work with your schema. There is no built-in sales, finance or other industry model. The Agent chooses the queries; Stellane checks access, records evidence and manages supported experiments.

## Choose your connection

| Connection | Queries, definitions, view lineage and relationship memory | Isolated write experiments |
| --- | --- | --- |
| PostgreSQL | Yes | Requires a branching provider |
| Neon connection URL | Yes | Add Neon API access to enable |
| Neon with API access | Yes | Yes |
| Stello | Yes | Yes |

**A Postgres connection is enough to start.** Docker, Stello and a Neon API key are not needed for analysis or memory. A Neon connection URL works as an ordinary Postgres connection.

For experiments, Stello provides fixed data states. Neon provides branches that Stellane treats as read-only baselines and results; an external database administrator can still change them. Neon results can depend on retained parent branches. The panel reports that retention, and the retained resources may incur Neon charges.

## Install from source

This is a development version. Use a local checkout; these instructions do not assume a published npm release.

Prerequisites: Node.js **24.9+**, pnpm **11.1.2** through Corepack, and DeepSeek Harness **0.2.2-rc.1** with a working model connection. The panel currently targets Harness Web.

```sh
git clone https://github.com/czNail/Stellane.git
cd Stellane
corepack pnpm install
corepack pnpm check
dsh plugin --profile web add "$PWD"
```

Restart the Harness Web Host after installing the plugin. If you start it from a terminal, stop the existing process and run:

```sh
dsh web
```

Harness opens the browser and prints its address. For a remote Host, use `dsh web --no-open` and your existing way of accessing that Host. Install the plugin in the same profile you run.

## Connect once, then chat

1. Open **Stellane → 数据源 (Data sources) → 添加数据源 (Add data source)**.
2. Select PostgreSQL or Neon, paste the connection URL and confirm the project directory. The current Harness project is filled in when available; the name defaults to the database name. The database itself may be remote.
3. Click **连接并开始使用 (Connect and start)**. Stellane tests the connection, stores credentials in a private file on the Host, and creates a read-only environment.
4. Open a normal chat in that project and ask a question. The bundled `stellane-data` Skill guides the Agent to the connected data; no separate Stellane chat is required.

Example prompts — replace the object names with your own:

> What tables are available, and how are they related?
>
> Count events by region. Check the join and show records that cannot be attributed.
>
> In a new chat: calculate another metric using the relationship we found. Verify that it still holds.

Multiple relevant sources? Name the one to use in the conversation. Business definitions are optional; add them under **数据目录 (Data catalog)** when a term needs an agreed meaning.

For a Neon experiment, select **启用独立试验 (Enable isolated experiments)** when adding the Neon source and provide its project ID, branch ID and API key. For Stello, use its exported client configuration and source branch. Then ask in ordinary chat:

> In an isolated branch, apply this proposed mapping and compare the result with the baseline. Keep the evidence.

## Where to look

| Panel | Purpose |
| --- | --- |
| 任务与结果 · Activity and results | Recent runs, experiment progress, evidence and results. Return to the original conversation. |
| 数据目录 · Data catalog | Tables, definitions, view lineage and saved relationship observations, including failed rechecks. |
| 探索 · SQL exploration | Run SQL manually or open a conversation bound to a specific environment. |
| 数据源 · Data sources | Add connections and see which capabilities each provides. |

You can stay in chat for daily work. Open the panel when you want to inspect or manage what happened.

## Current scope

- Memory covers verified row keys and equality joins. View lineage comes from Postgres metadata. It does not yet model every output-column transformation or external ETL job.
- Saved data matches are observations, not proof of business meaning. Live data and Neon branches require fresh checks before reuse; Stellane does not continuously watch external writes.
- Structured metrics support a chain of equality joins, grouped row counts, optional numeric sums and one equality filter. Other calculations use ordinary read-only SQL with their own execution evidence.
- Source connections are read-only through Stellane. Writes are restricted to plugin-created experiment branches. Use a database role with the access you want to grant.
- State and evidence live on one Harness Host. Distributed hosting and a general multi-Agent experiment scheduler are outside the current scope.

PostgreSQL and Stello have real-database integration tests. Neon branching is experimental: its API contract tests pass, but cloud end-to-end validation has not yet been run. An opt-in `test:neon:live` suite is available for a dedicated Neon test project. See [the test guide](DEVELOPMENT.md#检查与验收) for requirements and coverage.

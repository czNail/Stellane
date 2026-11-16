# Stellane

**Understand your Postgres data. Explore different paths. Keep the evidence for every result.**

Stellane is a DeepSeek Harness plugin for asking questions and testing ideas in ordinary chat. It helps the Agent understand tables, remember verified relationships and revisit them when data changes. With Neon branching or Stello, the Agent can try alternative changes on separate database branches, compare their results and keep the source unchanged through Stellane.

Multiple trial paths are central to Stellane: start from a common baseline, let each idea develop independently, then make a decision with evidence. The side panel shows sources, memory, SQL, experiment progress and retained results.

[中文说明](README.zh-CN.md) · [Try the demos](examples/README.md) · [Branch experiment walkthrough](docs/experiments.md) · [Product decisions](PRODUCT.md) · [Development and testing](DEVELOPMENT.md) · [Install, upgrade and remove](docs/install-and-maintain.md) · [Data and privacy](docs/data-and-privacy.md)

## When it helps

| Situation | What you do with Stellane | What you gain |
| --- | --- | --- |
| You inherit an unfamiliar database | Ask how tables relate; inspect definitions and view lineage | An explanation backed by the actual schema and queries |
| Several analyses need the same joins | Find and verify relationships once, then retrieve and recheck them in later chats | Less repeated exploration, with evidence of whether old knowledge still applies |
| A report silently drops records after data changes | Check relationship coverage and inspect failed observations | Missing records remain visible in totals and the reason is traceable |
| A mapping could be repaired in more than one way | Try A and B on separate branches from one baseline | Comparable results without mixing the two proposed repairs |
| You want to test an allocation rule or a schema change | Change data, tables or views in an experiment and run verification queries | A measured result before deciding whether to adopt the change elsewhere |

These features work with your schema. Stellane has no built-in sales, finance, telemetry or support model. The Agent chooses the queries and proposed changes; Stellane checks access, validates supported claims and retains execution evidence.

## One baseline, several paths

A useful experiment asks more than “did this SQL run?” It asks “what changes under this hypothesis, compared with the same starting data?”

```mermaid
flowchart LR
    S[Source database] --> B[Saved baseline]
    B --> A[Experiment A]
    B --> C[Experiment B]
    A --> RA[Result A and evidence]
    C --> RB[Result B and evidence]
    RA --> D[Compare and decide]
    RB --> D
```

1. **Save one baseline.** A and B use the same starting point, instead of taking separate samples of a moving source.
2. **Give each idea its own branch.** A mapping repair, data update or schema change in A does not become part of B.
3. **Measure both with the same definition.** Compare totals, coverage, group changes and the relevant SQL evidence. Two variants can both eliminate missing joins while assigning records differently; complete coverage alone does not establish which business rule is correct.
4. **Keep the results and end the trials.** Temporary resources are cleaned up or reported as retained dependencies. Choosing a result does not automatically apply it to production.

For example, ask in one ordinary chat:

> Save a common baseline. In separate experiments, test mapping hypothesis A and mapping hypothesis B using the rules I supplied. For each, report the same metric, unmatched records and changes by group. Compare both with the baseline, retain the evidence, and leave the source unchanged.

The current workflow supports separately named experiments from a shared baseline. Run the variants in the same conversation and compare their saved results there; inspect each task in the panel. Automatic multi-Agent scheduling and a combined multi-variant comparison screen are future work. The [branch walkthrough](docs/experiments.md) provides concrete data, prompts, expected results and cleanup steps.

## Choose your connection

| Connection | Queries, definitions, view lineage and relationship memory | Isolated write experiments |
| --- | --- | --- |
| PostgreSQL | Yes | Requires a branching provider |
| Neon connection URL | Yes | The URL alone has no branching management |
| Open-source Neon in Docker | Yes | [Experimental local controller](docs/local-neon.md); full runtime acceptance pending |
| Neon cloud API | Yes | Experimental adapter; cloud validation is outside this preview |
| Stello | Yes | Yes |

**A Postgres connection is enough to start.** Analysis and memory do not require Docker, Stello or a Neon API key. Use branching when a question needs an isolated change to data or schema; a read-only question can stay on the source connection.

Stellane uses the provider's database branching rather than implementing its own copy engine. Stello provides fixed data states. Neon provides branches that Stellane treats as read-only baselines and results; an external administrator can still change them. Neon results can depend on retained parent branches. The panel reports that retention. Local Docker timelines occupy disk; a cloud account can incur charges. The self-hosted Docker route is under validation; its complete runtime test has not passed yet. Branch startup time and resource cost depend on the provider and workload.

## Install the preview

Version **0.3.0-preview.1** targets Harness Web with Node.js **24.9+** and DSH **0.2.2-rc.1 through rc.3**. Start with a DSH profile whose model connection already works. The preview archive contains built code; users do not need a compiler or a checkout.

Install the `.tgz` supplied with this preview, using its actual absolute path:

```sh
dsh plugin --profile web add /absolute/path/stellane-harness-plugin-0.3.0-preview.1.tgz
```

Restart the same Web Host, then open Stellane from the sidebar. If you launch it in a terminal, stop that Host and run `dsh web`; for a remote Host use `dsh web --no-open` and your existing access method. This repository does not claim that the preview is already published to npm.

The interface supports English and Chinese, with a language selector in the panel. See [installation and maintenance](docs/install-and-maintain.md) for state locations, upgrade backups and removal. Linux is the current real-runtime validation environment; other operating systems still need their own end-to-end validation.

## Install from source

For development, use Node.js 24.9+ and pnpm 11.1.2 through Corepack:

```sh
git clone https://github.com/czNail/Stellane.git
cd Stellane
corepack pnpm install
corepack pnpm check
dsh plugin --profile web add "$PWD"
```

Restart the same Host after changing the built plugin. Development and release checks are in [DEVELOPMENT.md](DEVELOPMENT.md).

## Try it without your own data

The repository includes small synthetic datasets, example questions, deliberate data changes and independently checkable expected results. You can see a relationship discovered, reused in a new chat and invalidated after a change, then test two repair paths with a branching provider.

With Docker running:

```sh
dsh plugin --profile web exec stellane-demo start
dsh plugin --profile web exec stellane-demo status
```

Follow the printed project and private connection-file instructions, then use the [step-by-step demos](examples/README.md). The local Postgres demo covers analysis and memory. The branch walkthrough additionally needs a configured Neon or Stello test source; starting the local demo does not create a cloud project.

Use `dsh plugin --profile web exec stellane-demo stop` when finished. From a source checkout, the equivalent commands are `pnpm demo start`, `status` and `stop`. Reset, data-change and provider setup instructions are in the demo guide. The helper manages its own labeled demo resources.

## Connect once, then chat

1. Open **Stellane → Data sources → Add data source**.
2. Select PostgreSQL or Neon, paste the connection URL and confirm the project directory. The current Harness project is filled in when available; the name defaults to the database name. The database itself may be remote.
3. Click **Connect and start**. Stellane tests the connection, stores credentials in a private file on the Host, and creates a read-only environment.
4. Open a normal chat in that project and ask a question. The bundled `stellane-data` Skill guides the Agent to the connected data; no separate Stellane chat is required.

Example prompts — replace the object names with your own:

> What tables are available, and how are they related?
>
> Count events by region. Check the join and show records that cannot be attributed.
>
> In a new chat: calculate another metric using the relationship we found. Verify that it still holds.

Multiple relevant sources? Name the one to use in the conversation. Business definitions are optional; add them under **Data catalog** when a term needs an agreed meaning.

For local Neon experiments, follow [the Docker Neon setup](docs/local-neon.md); the installed package includes its launcher. Cloud API access is a separate experimental route. For Stello, use its exported client configuration and source branch. You can then request a single trial or multiple named trials from a shared baseline. See [experiments](docs/experiments.md) for the exact workflow and provider differences.

## Where to look

| Panel | Purpose |
| --- | --- |
| 任务与结果 · Activity and results | Recent runs, experiment progress, evidence and results. Return to the original conversation. |
| 数据目录 · Data catalog | Tables, definitions, view lineage and saved relationship observations, including failed rechecks. |
| 探索 · SQL exploration | Run SQL manually or open a conversation bound to a specific environment. |
| 数据源 · Data sources | Add connections and see which capabilities each provides. |
| 管理与清理 · Management | Disable access, update credentials, archive memory, remove retained branches or delete local data. |

You can stay in chat for daily work. Open the panel when you want to inspect or manage what happened.

## Current scope

- Memory covers verified row keys and equality joins. View lineage comes from Postgres metadata. It does not yet model every output-column transformation or external ETL job.
- Saved data matches are observations, not proof of business meaning. Live data and Neon branches require fresh checks before reuse; Stellane does not continuously watch external writes.
- Structured metrics support a chain of equality joins, grouped row counts, optional numeric sums and one equality filter. Other calculations use ordinary read-only SQL with their own execution evidence.
- Source connections are read-only through Stellane. Writes are restricted to plugin-created experiment branches. Use a database role with the access you want to grant.
- State and evidence live on one Harness Host. Distributed hosting, general multi-Agent experiment scheduling and automatic production adoption are outside the current scope.

PostgreSQL and Stello have real-database integration tests. Neon cloud execution remains outside this preview; API contract checks are not a cloud acceptance result. The self-hosted Docker setup uses open-source Neon services and a Stellane development controller, independently of a paid cloud account. See [the test guide](DEVELOPMENT.md#检查与验收) for requirements and coverage. Demo outputs illustrate behavior on synthetic data, not a promise of production accuracy or speed.

See [release status](docs/release-status.md) for verified behavior and remaining release gates.

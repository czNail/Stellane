# What Stellane reads, sends and keeps

[中文](data-and-privacy.zh-CN.md) · [Install and maintain](install-and-maintain.md)

Stellane runs inside your DSH Host. It has no separate Stellane model endpoint or telemetry service. Your DSH model provider and its data policy still apply: a database question can put database information into the model's context.

## Data flow

| Information | Where it can go | Why |
| --- | --- | --- |
| Table/column names, types, comments, constraints and view dependencies | Host evidence; DSH tool results and model context | Discover and explain the data |
| Business definitions and relationship observations | Host state; selected content in DSH/model context | Reuse agreed meaning and previously checked relationships |
| Questions, SQL, parameters and bounded row previews | Host execution evidence; DSH chat/model context | Execute, explain and later inspect the result |
| Experiment names, branch identities, assumptions, outcomes and errors | Host evidence; DSH/model context where returned by a tool | Track isolated trials and explain failures |
| Database passwords, API tokens and Stello credentials | Private Host files or user-provided environment/file references; the relevant database/provider | Authenticate; credentials are not intentionally included in Agent tool results or model prompts |

Query previews are limited to 200 rows and 128 KiB, but a small preview can still contain sensitive values. Do not select credentials or private data merely because the output is bounded. Use an appropriately restricted database role and a suitable DSH model provider. Source access is read-only through Stellane; provider management credentials can have wider permissions outside the plugin.

Database rows, comments and imported definitions are **data, not instructions**. The bundled Skill tells the Agent not to follow embedded requests to reveal secrets, change access, run unrelated SQL or contact external destinations. SQL examples in definitions are references; importing them does not execute them. These boundaries do not make arbitrary database content or model decisions trustworthy.

## Retention and deletion

Stellane keeps local evidence so that a later answer can be checked against what actually ran. Memory is a checked observation, not a continuously monitored truth. A failed recheck is retained alongside its original evidence. See [the management guide](install-and-maintain.md#understand-the-management-actions) for the exact actions.

- **Archive** stops reuse and frees active memory/definition capacity. Historical records remain readable.
- **Remove local connection** removes registration and unused plugin-created credentials after work and retained resources are resolved. Evidence remains.
- **Delete local data and history** removes the selected disabled source's local records, including memory, definitions, SQL, previews and experiment evidence. It requires the source's exact name and refuses while active/unknown work or retained branches remain.
- **Remove this branch** deletes a precise plugin-created database resource, child before parent. It preserves local evidence and never deletes the source database.

Local deletion is logical deletion, **not guaranteed physical erasure**. SQLite uses secure deletion for deleted pages, but WAL files, filesystem snapshots, disk backups, DSH conversations, browser/session state and model-provider logs may hold copies. Upgrade snapshots in `backups/` are intentionally independent and are not erased by source deletion. Handle those copies with their own retention controls. Plugin removal alone does not delete any of them.

Credentials supplied by the user through `env:` or external `file:` references are never deleted automatically. Only files recorded as created by Stellane, still in its private credentials directory, and no longer referenced elsewhere are eligible for removal. Updating a password does not revoke the old password at the database; perform server-side rotation using your database's normal controls.

## Scope of the preview

The owner panel controls one Host's state. Project/session checks restrict Agent access within that Host; this is not an organization-wide identity system or an audit service immune to a Host administrator. State is not encrypted by Stellane; use your operating system's disk and account protections where needed.

PostgreSQL analysis does not require a branching service. The Docker Neon development setup runs local open-source services and a Stellane controller; cloud API access is a separate experimental route. No cloud key or paid account is required for the local setup. Local timelines, database volumes and backups occupy disk and need their own cleanup.

For bug reports, use synthetic data and remove connection URLs, tokens, row previews and private paths from logs or screenshots. Do not attach `state.sqlite`, its backups, credential files or a full DSH session to a public issue. Report suspected vulnerabilities using [SECURITY.md](../SECURITY.md).

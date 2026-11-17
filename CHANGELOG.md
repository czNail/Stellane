# Changelog

## 0.2.0

- Ask the agent to remember a business term. Review the matched tables, fields and conditions below the answer, then save the definition for future chats.
- Open query evidence directly from chat. Inspect results and relationship coverage, expand SQL when needed, then return to the same chat.
- See progress and results for plans from the same branch baseline together. Switch between proposals and inspect each result's evidence.
- Run one PostgreSQL sample from discovery through relationship reuse and invalidation. Use the same sample to verify branch isolation.

PostgreSQL and regular Neon PostgreSQL URLs support analysis, lineage and memory. Stello supports isolated write experiments. Local and cloud Neon branching remain experimental.

## 0.1.0

- PostgreSQL analysis and verified relationship memory; Stello experiments from a shared baseline with independently saved evidence.
- Resume a stalled Stello derivation or deletion using the original resource and current revision. Status checks remain read-only, and SQL writes are not replayed.
- Keep local and cloud Neon branching experimental. A PostgreSQL-compatible connection still supports ordinary read-only analysis.
- Installable archives include working DSH helper commands and bilingual onboarding, maintenance and privacy guidance.

See the archived v0.1.0 acceptance records. [English](https://github.com/czNail/Stellane/blob/v0.1.0/docs/release-status.md) · [中文](https://github.com/czNail/Stellane/blob/v0.1.0/docs/release-status.zh-CN.md)

## 0.3.0-preview.1

Preview for DSH Web 0.2.2-rc.1–rc.3 and Node.js 24.9+. Published as a temporary preview on npm and GitHub.

- Ordinary chat can inspect PostgreSQL, save checked relationship memory, recheck it after data changes and open execution/metric evidence.
- Branch experiments retain a common baseline, independent proposals and their results. PostgreSQL analysis remains usable without a branch provider. Stello provides branch access. The local Docker Neon controller is experimental and still needs complete runtime acceptance; cloud Neon remains experimental.
- Management can disable access, probe replacement credentials, archive memory/definitions, remove precise retained resources, remove local registrations and explicitly delete local source history.
- English/Chinese UI, inherited theme styling, keyboard/dialog behavior and clearer connection/recovery feedback make the panel an inspection and management companion to chat.
- Distribution includes built code, the embedded Skill, synthetic scenarios and an installed `stellane-demo` command. Package checks install the archive into a fresh directory.
- State format 7 adds exclusive ownership, checked migration backups and rejection of newer formats. Stop all older Hosts before upgrading; early development builds cannot safely read this format. See [upgrade and recovery](docs/install-and-maintain.md#upgrade-and-recover).

The preview is a single-Host product. It does not provide organization-wide access administration, automatic production adoption, general multi-Agent scheduling or complete external/column-transformation lineage. Contract tests, actual database tests and model-driven demonstrations are separate evidence; a skipped provider test is not acceptance. See [development and validation](DEVELOPMENT.md).

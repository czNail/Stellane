# Release checkpoint — 2026-11-16

[中文](release-status.zh-CN.md) · [Independent-agent first use](first-use-validation.md)

This is a development checkpoint for **0.3.0-preview.1**, not an announcement that every release gate passed. Work was paused at the owner's request after preserving the completed changes. No npm package was published.

## Verified in this round

Final checkpoint checks: **43 base tests and 8 real PostgreSQL integration tests passed**, plus type checking and build.

- Fresh archive installation and Host startup in independent DSH **0.2.2-rc.1** and **rc.3** profiles on Linux. Each fresh profile received its own Stellane state directory.
- Four ordinary chats with a real configured model: discover implicit relationships, reuse the same saved relationships in a new chat, recheck after data drift, and ignore an instruction embedded in a synthetic business definition. These were independent-agent acceptance checks, not external human usability research. The total stayed **5 records / 150**, with **1 record / 20** explicitly unattributed after drift.
- Actual PostgreSQL management tests, including credential rotation, failed-probe rollback, access disabling and local history removal while preserving source data. Owner-only management, retained-resource dependencies and archival capacity have automated coverage.
- State ownership, migration backups and refusal of newer formats; tests include concurrent processes and crash recovery. A separate clean installation with **Node 24.9.0 / pnpm 11.1.2** passed type checking, 41 then-current base tests and the build.
- Actual rc.1 management UI connection, invalid/valid credential rotation, disabling/re-enabling access and language switching. Narrow-screen fixes were checked in a browser; the final rebuilt archive still needs the complete UI matrix repeated.

## Resume here

1. **Stello full branch run:** the first run reached result A, then a cleanup response was rejected before the original operation later completed. Original-request recovery and exact management cleanup succeeded, with source data unchanged. A subsequent run retained an unresolved original branch request. Do not count either run as a fully passing automated A/B run. Continue from recorded identities; do not replay SQL or create replacement branches. A new regression covers observing an admitted deletion without resubmitting it.
2. **Local Neon Docker:** provider/configuration contract tests pass. The local controller and Docker runtime are implemented but have **not passed a complete live deployment/A/B/cleanup test**. Official storage-image downloads were still in progress at this checkpoint. Verify actual image CLI/configuration, startup, fixed-LSN read-only computes, shared-baseline isolation, restart and cleanup before calling this supported. Cloud Neon validation is deferred; no paid cloud project is required for the next step.
3. **Final distribution lifecycle:** rebuild and retest the final archive in both supported DSH versions, including plugin disable/re-enable, uninstall/reinstall with preserved state, management deletion/archival and keyboard/theme/narrow-screen paths. Earlier successful package checks are not proof of all later changes.
4. **Release readiness:** inspect the new CI run after push, review the final package contents and obtain external human first-use feedback. Keep Linux-only verification and synthetic-data limitations explicit.

The implementation, bilingual maintenance/privacy guides, issue templates and CI configuration are committed together so the next round starts from one reviewable checkpoint. See [installation and maintenance](install-and-maintain.md), [local Neon](local-neon.md), and [demo validation](demo-validation.md) for procedures and earlier evidence.

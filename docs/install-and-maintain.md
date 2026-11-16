# Install and maintain Stellane

[中文](install-and-maintain.zh-CN.md) · [Quick start](../README.md) · [Data and privacy](data-and-privacy.md)

## Install the preview

Use Node.js **24.9+**, a DSH **0.2.2-rc.1–rc.3** Web profile and a working model connection in DSH. This is **0.3.0-preview.1**. Linux is the current real-runtime validation environment; do not assume other platforms have passed the same tests.

Download the preview archive supplied for this version. It contains built Host/client code, the Skill and demo data; there is no build step for package users. This release is not claimed to be published to npm.

```sh
dsh plugin --profile web add /absolute/path/stellane-harness-plugin-0.3.0-preview.1.tgz
```

Restart the Web Host using that profile, then open **Stellane → Data sources → Add data source**. A normal PostgreSQL URL is enough for analysis, lineage and memory. Check that ordinary DSH chat can reach its model before diagnosing a database connection. Stellane uses that same model configuration.

For a synthetic playground with Docker:

```sh
dsh plugin --profile web exec stellane-demo start
dsh plugin --profile web exec stellane-demo url
```

Use the project directory printed by the helper. The installed helper keeps its files under `~/.local/share/stellane-demo`; it does not write into the installed npm package. The source-checkout command `pnpm demo` instead uses `.stellane-dev/demo`. Set `STELLANE_DEMO_HOME` to an absolute path to choose another location. Container ownership includes that state path, so separate demo directories do not adopt one another's containers. `stop` retains the database volume; `reset` restores only the synthetic schemas. See [the demos](../examples/README.md).

## Where state lives

Stellane stores connections, memory and execution evidence on the Harness Host, not in your browser. The state directory is chosen in this order:

1. An explicit absolute `stateDirectory` in the plugin configuration.
2. An existing `~/.local/share/stellane/state.sqlite`, to preserve earlier installations.
3. For a fresh installation, `stellane-state` inside the DSH profile directory. Hosts that do not provide a profile directory use the legacy location above.

The directory and credential files are private to the Host user (`700` / `600` on Unix). The SQLite format is **7**. Only one Core may own a directory at a time: `owner.sqlite` holds an operating-system-backed exclusive lock. If a second Host reports that the state is in use, stop the owning Host or choose a separate state directory. **Do not delete the lock file.** The operating system releases the lock when its owner exits, including a crash.

Different profiles may still select the same existing legacy state. Give them different explicit directories if you want them to run independently; copying a database does not make its recorded remote branch identities independent.

### Give an independent Host its own state directory

Stop that Host, then edit its profile's `cordis.patch.yml`. The default Web profile file is `~/.dsh/profiles/web/cordis.patch.yml`; with `DSH_HOME` set, it is `<DSH_HOME>/profiles/web/cordis.patch.yml`. The file is a top-level YAML array. Merge this entry into the existing array; if `id: stellane` already exists, update only its `config.stateDirectory`. Preserve the model configuration and other plugin entries:

```yaml
- id: stellane
  config:
    stateDirectory: /absolute/private/path/stellane-state
```

Replace the example with a private absolute path writable by the Host user, using a different directory for each independent Host. A new directory starts with empty state; existing connections and evidence are not moved automatically. To retain them, keep the Host stopped, copy the complete state directory and credential files using the backup steps below, then point the configuration at the copy and restart. Copies retain the same remote branch identities: do not run two copies of one state as independent sources.

## Upgrade and recover

1. Stop the old Host. Early development versions did not enforce ownership or reject newer formats, so they must not run alongside the preview.
2. Keep a private copy of the complete state directory, including managed credential files. Back up demo/controller data separately if you use it.
3. Install the new archive in the same profile and restart the Host. Before a format upgrade, Stellane writes a checked SQLite snapshot under `backups/`; it includes committed data still in the WAL. A failed migration preserves the prior format and data.
4. Check sources, recent evidence and retained branches in **Management** before starting new work.

Do not downgrade against a migrated directory. Guarded versions refuse newer formats; early development builds may not. To recover, stop the Host, preserve the failed directory and restore a consistent backup to a separate private directory with matching credential files. Point a compatible plugin at that directory. Keep the original remote resource identities and reconcile unknown operations before creating replacements. A SQLite backup alone does not include external credential files, DSH chats or provider storage.

## Understand the management actions

| Action | What it does | What remains |
| --- | --- | --- |
| **Disable access** | Blocks Agent discovery, new queries and new branches for this source | Owner evidence, reconciliation and cleanup; it does not revoke the database role outside Stellane |
| **Update credentials** | Probes the replacement before switching; PostgreSQL must keep the same host/port/database/user, TLS and channel-binding settings | Evidence and source identity; only unused credentials created by Stellane are removed |
| **Archive and stop reuse** | Excludes a memory/definition version from reuse and frees its active capacity | Historical evidence and that archived version; an older version is not silently revived |
| **Remove this branch** | Deletes that exact plugin-created provider resource after checking dependencies | Local evidence; the source database is never eligible |
| **Remove local connection** | Removes a disabled connection registration and its unused managed credentials | Local memory and historical evidence; remote source data |
| **Delete local data and history** | After exact-name confirmation, removes this disabled source's local records, memory, definitions and evidence | Backups, DSH chats, model-provider logs and source data; this is not physical media erasure |

The three management tabs are **Access and credentials**, **Retained branches**, and **Memory and definitions**. Source removal and local history deletion are blocked while work is active, an operation is unknown, or a managed branch remains. Remove children before parents. A shared baseline remains while any child depends on it. Removing a result may also make its parent eligible for removal; follow the panel's remaining reasons.

**Finish experiment** closes temporary work; it does not mean “delete all saved results.” Neon results can retain parent timelines even after their compute is stopped. Docker timelines still consume local disk. Use the retained-branch list for deliberate removal. If removal was interrupted, **Check removal** follows the original recorded request and exact resource identity rather than creating a replacement request.

## Uninstall

First finish/reconcile experiments and remove unwanted retained branches in Management. If you want local history deleted, disable the source and use **Delete local data and history** while the plugin is still installed. User-supplied `env:`/`file:` credentials are never deleted by these actions.

Stop the Host, then remove the package from the same profile:

```sh
dsh plugin --profile web remove @stellane/harness-plugin
```

Restart the Host. Removing the package does not remove Stellane state, backups, demo volumes, DSH chats or provider databases. Review those separately according to your retention needs. See [data and privacy](data-and-privacy.md) for what each may contain.

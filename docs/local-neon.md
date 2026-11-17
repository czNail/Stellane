# Try database branches with local Neon

**Experimental.** Live validation of startup, branching, restart and cleanup is pending.

[中文](local-neon.zh-CN.md) · [Experiment walkthrough](experiments.md) · [Development](../DEVELOPMENT.md#neon)

This development setup runs real open-source Neon services in Docker: a pageserver, broker, one safekeeper and separate compute processes for timelines. Branches use Neon timelines; read-only computes use a fixed LSN. It does not simulate a branch by copying tables.

The controller in this repository is a **Stellane local development controller**, not the official Neon cloud control plane. It does not require a Neon account, cloud API key or paid cloud resources. It is also not the “Neon Local” proxy to a cloud project. This single-node setup is for development and synthetic experiments, not a high-availability deployment.

## Start and connect

Use Node.js 24.9+ and Docker accessible to the current user. With Stellane installed:

```sh
dsh plugin --profile web exec stellane-neon start
dsh plugin --profile web exec stellane-neon status
```

The package stores instances under `~/.local/share/stellane-neon/`; the default instance is `local`. An absolute `STELLANE_NEON_HOME` overrides that parent directory. From a source checkout, replace `dsh plugin --profile web exec stellane-neon` with `corepack pnpm dev:neon`; source instances live under `.stellane-dev/neon-<instance>`. First startup downloads service images, whose resolved digests are recorded in instance state. No data is written into the installed package.

Use **Data sources → Add data source → Neon (Docker)** in Stellane. Paste the absolute `provider.json` path printed by `start`, and use its printed project directory for ordinary DSH chat. The default package file is `~/.local/share/stellane-neon/local/provider.json`; a source checkout uses `.stellane-dev/neon-local/provider.json`. It references a private local controller token; do not paste the token into chat. Only a loopback controller endpoint is accepted by this connection path.

The source starts empty. Use a database client and a setup role with the private URL from `dsh plugin --profile web exec stellane-neon url` to load `examples/datasets/telemetry/setup.sql` followed by `drift.sql`. The Agent uses the source read-only.

## Repeatable validation

From the checkout, the dedicated local-provider suite uses this configuration:

```sh
STELLANE_NEON_LOCAL_CONFIG="$PWD/.stellane-dev/neon-local/provider.json" corepack pnpm test:neon:local
```

It seeds a synthetic source, creates A/B trials from one baseline, verifies isolated writes, read-only results and source preservation, then uses product management to remove only its recorded resources. The supplied source must be dedicated to testing. Contract tests (`pnpm test:neon`) exercise simulated responses and are a different check. This local test fails when the fixture is unavailable; a failed live test is not a passing result; keep its printed state/report path for recovery.

After loading the telemetry fixture, run `demo:branches` from a built checkout under `~/Temp` with `--neon /absolute/path/provider.json` pointing to the local Neon configuration. The runner calls Core directly. Verify an ordinary DSH chat separately. [Expected results and cleanup steps](../DEVELOPMENT.md#真实分支对照).

## Stop, resume and recover

```sh
dsh plugin --profile web exec stellane-neon stop
dsh plugin --profile web exec stellane-neon start
dsh plugin --profile web exec stellane-neon reconcile
```

`stop` shuts down the local controller and its owned containers while retaining credentials, source, timelines and Docker volumes. `start` resumes that same instance. `reconcile` resumes only already recorded local control operations; it does not replace unknown requests with new ones. Use `status` and the private `controller.log` in the printed instance directory to diagnose startup failures.

Separate work can use `--instance another-name` on every command; its directory is `<STELLANE_NEON_HOME>/another-name` for a package (the default parent is above), or `.stellane-dev/neon-another-name` for source development. Resource labels and identities are checked before control operations. Do not reuse another task's state directory or delete it while its resources remain.

Ending an experiment can retain its result and parent timelines. **Management → Retained branches** shows the dependency reasons; remove children before parents when you no longer need them. That operation never deletes the source. Local branches consume disk even without cloud billing. Stopping the development instance is not full removal of its volumes, and deleting local Stellane evidence does not delete provider storage.

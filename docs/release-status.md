# 0.1.0 release acceptance

[中文](release-status.zh-CN.md) · [First-use walkthrough](first-use-validation.md) · [Install and maintain](install-and-maintain.md)

The 0.1 release paths are **PostgreSQL** for read-only analysis, lineage and verified memory, and **Stello** for experiments, saved results and branch cleanup. A Neon PostgreSQL URL can still be used as a read-only data source. Local and cloud Neon branching remain experimental and outside this runtime acceptance scope.

| Check | Result |
| --- | --- |
| Recover the original Stello request | Recovered the real branch left in `preparing` during the previous run. Verified its original ticket, branch identity and revision before resuming; no second create was sent. Closed the experiment, removed its baseline and matched the source fingerprint. |
| Stello A/B from one baseline | The published telemetry demo passed on an isolated deployment. Baseline North 3/90, South 1/40, unattributed 1/20; A North 4/110, South 1/40; B North 3/90, South 2/60. Changing A did not change B's starting data. Writing B did not change the saved A result. Both retained results and the baseline were removed by identity; the source fingerprint was unchanged. |
| Base checks and real PostgreSQL | Frozen installation, type checks and build passed using Node 24.9.0 and pnpm 11.1.2. 44 base tests and 8 real PostgreSQL tests passed. |
| DSH archive | The built 0.1.0 Host and client were installed in private DSH rc.1 and rc.3 Linux profiles. Both started and ran the installed `stellane-demo` command. Each passed 48 installed UI checks across both languages, dark/light, 320/390px and keyboard focus, without injecting source or CSS. |
| Stello in ordinary chat | A real model on rc.3 started an isolated experiment, changed the branch value from 120 to 135, saved SQL evidence in a fixed result, and closed the work. The source stayed at 120. The panel showed the result; management removed only its branch and kept the evidence. |
| Installation lifecycle | On rc.1, removed the package, installed the published npm preview, explicitly installed the 0.1.0 archive, and restarted with the same source registration intact. |

These results cover a single Host on Linux and scoped synthetic fixtures. The separate first-use walkthrough is an independent-agent test; feedback from outside users and coverage of other operating systems can follow.

## Publish the checked archive

```sh
corepack pnpm test:package
sha256sum .stellane-dev/release/stellane-harness-plugin-0.1.0.tgz
```

The checksum is also recorded in `package-check.json` alongside the archive. Once the commit's CI passes, use the checked archive for npm and the GitHub release attachment. The existing npm preview, `0.3.0-preview.1`, sorts higher than `0.1.0`. Publish 0.1.0 under a non-default tag such as `stable`, test an install, then set the [npm `latest` tag](https://docs.npmjs.com/cli/v11/commands/npm-dist-tag/) to 0.1.0 explicitly. Keep the preview under `next`. Existing preview users can install `@stellane/harness-plugin@0.1.0` explicitly rather than relying on an automatic update to a lower version. Switch the default README install command after publishing.

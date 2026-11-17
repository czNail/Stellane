# 0.1.0 release acceptance

[中文](release-status.zh-CN.md) · [Install and maintain](install-and-maintain.md)

Stellane 0.1 supports PostgreSQL analysis, lineage and verified relationship memory, plus Stello experiments from a common baseline. Local and cloud Neon branching remain experimental.

| Check | Result |
| --- | --- |
| Recover the original Stello request | Recovered the real branch left in `preparing` during the previous run. Verified its original ticket, branch identity and revision before resuming; no second create was sent. Closed the experiment, removed its baseline and matched the source fingerprint. |
| Stello A/B from one baseline | The published telemetry demo passed on an isolated deployment. Baseline North 3/90, South 1/40, unattributed 1/20; A North 4/110, South 1/40; B North 3/90, South 2/60. Changing A did not change B's starting data. Writing B did not change the saved A result. Both retained results and the baseline were removed by identity; the source fingerprint was unchanged. |
| Base checks and real PostgreSQL | Frozen installation, type checks and build passed using Node 24.9.0 and pnpm 11.1.2. 44 base tests and 8 real PostgreSQL tests passed. |
| DSH archive | The built 0.1.0 Host and client were installed in private DSH rc.1 and rc.3 Linux profiles. Both started and ran the installed `stellane-demo` command. Each passed 48 installed UI checks across both languages, dark/light, 320/390px and keyboard focus, without injecting source or CSS. |
| Stello in ordinary chat | A real model on rc.3 started an isolated experiment, changed the branch value from 120 to 135, saved SQL evidence in a fixed result, and closed the work. The source stayed at 120. The panel showed the result; management removed only its branch and kept the evidence. |
| Installation lifecycle | On rc.1, removed the package, installed the published npm preview, explicitly installed the 0.1.0 archive, and restarted with the same source registration intact. |

Earlier preview walkthroughs checked the synthetic PostgreSQL demo in ordinary DSH chats. A new chat reused the same two verified relationship observations. After data drift, it reported all 5 events and 150 units, including the unattributed event and its 20 units, and linked the failed check to the original observation.

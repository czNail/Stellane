# Stellane

Stellane is a DeepSeek Harness plugin for investigating PostgreSQL data in ordinary chat. Ask which tables feed a report, find why a total is short, and open the SQL behind the answer. With Stello, test different changes on separate database branches and keep the evidence for each result.

[中文](README.zh-CN.md) · [Walk through a missing-record investigation](examples/README.md) · [Branch experiments](docs/experiments.md)

## A report shows 130. The source adds up to 150.

The event table contains **five active events totalling 150**. The report groups them by area and returns **130**.

- **Follow the lineage.** The PostgreSQL report view depends on the event, device and area tables. That tells you where to look for the missing amount.
- **Check the current data.** One event worth 20 has no matching device. The report's inner join drops it. The coverage check can show it separately and keep its value in the total.
- **Reuse verified relationships.** A later chat can find the joins verified earlier. After a data change, you can open the original check and the failed recheck side by side.

A normal PostgreSQL connection is enough for this workflow. [Try it on sample data](examples/README.md).

## Test each proposed change on its own branch

A support ticket needs **90 minutes** and has no team assigned. Sending it to General creates **390 minutes of work against a capacity of 300**. Sending it to Specialist gives General **300 / 300** and Specialist **290 / 480**. Two other options are to move one more ticket to Specialist to free 60 minutes for General, or add 90 minutes of temporary capacity to General. Compare capacity, transfers and staffing costs before choosing.

With Stello, save the starting data once and give each option its own branch. Apply each change independently and compare the results using the same calculation. The source stays read-only through Stellane.

In 0.1, one DSH chat can run several separately named experiments and open their evidence. The next workflow we want is one task with four subagents, each exploring its own branch from that baseline, with the parent comparing the results. [See the current walkthrough and the four-subagent design](docs/experiments.md).

## Install and ask a question

Use Node.js **24.9+**, DeepSeek Harness Web **0.2.2-rc.1 through rc.3**, and a working DSH model connection. Installation was tested on Linux.

In DSH, open **Plugins → Add plugin** and enter `stellane`, or run:

```sh
dsh plugin --profile web add stellane
```

1. Restart the Web Host. Open **Stellane → Data sources → Add data source**.
2. Choose **PostgreSQL**, paste the connection URL, select your project directory and click **Connect and start**. A regular Neon PostgreSQL URL works here too.
3. Click **Ask in project chat**, or open an ordinary DSH chat in that project. Ask:

> Which tables feed this view? Check whether it drops any records and show me the reason and query evidence.

Use **Data catalog → Relationships and lineage** for view dependencies and verified joins. Open **Activity and results** for SQL, experiment progress and saved results.

In 0.1, lineage covers upstream dependencies of PostgreSQL views. Stello is the verified path for isolated writes. Local and cloud Neon branching are experimental.

[Install, upgrade and remove](docs/install-and-maintain.md) · [Data and privacy](docs/data-and-privacy.md) · [Development and testing](DEVELOPMENT.md)

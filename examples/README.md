# Pick up from a relationship you already verified

[中文](README.zh-CN.md) · [Install Stellane](../README.md#install-and-ask-a-question) · [Branch rehearsal](../docs/experiments.md)

This runnable PostgreSQL fixture has event, device and area tables with no foreign keys between them. First find how an event gets its area. Then start a new chat using both the saved joins and a business definition you confirmed. Finally change one sample record and see where the old relationship stops matching.

## Connect the demo database

Install Stellane, start Docker and run these commands on the machine hosting DSH:

```sh
export STELLANE_DEMO_HOME="$HOME/Temp/stellane-demo"
dsh plugin --profile web exec stellane-demo start
dsh plugin --profile web exec stellane-demo url
```

1. In **Stellane → Data sources → Add data source**, choose **PostgreSQL** and paste the URL printed by the second command.
2. Use the **Project** path printed by `start`. Name the connection `Stellane demo` if you like, then click **Connect and start**.
3. Click **Ask in project chat**. Use the same DSH project when you start another chat.

## 1. Start with a question and verify the joins

> In `stellane_demo_telemetry`, count active events by area. Find how each event gets its area, check whether the joins cover all active events, and save the relationships you verify.

Expect **North 4, South 1, total 5**. In **Data catalog → Relationships and lineage**, look for the two checks. An event's device token needs to match a device, and that device's zone needs to match an area. The evidence shows the scope of each check and how many rows had no match.

## 2. Save a confirmed business term and open a new chat

In the same chat, ask:

> Remember “Countable event”. It is a row in `stellane_demo_telemetry.event_log` with `state = 'active'`. Each row is one event and its reading comes from `magnitude`.

Check the definition and table below the answer, then click **Save definition**. Start another chat in the same project:

> Sum the readings of countable events by area. Use the saved definition, recheck the joins we found earlier, and show the query evidence.

Expect **North 110, South 40, total 150**. The definition tells the agent which rows and field to use. The verified joins help it find the area.

## 3. Change the data and see where the saved join fails

Keep the connection and saved records. In the same terminal, run:

```sh
dsh plugin --profile web exec stellane-demo drift
```

In another new chat, ask:

> Compare `active_event_totals` with the count and sum of readings for all countable events in the detail table. Use Stellane's metric check to show unmatched records, explain where the report drops them, and give me the evidence.

The detail table still has **5 events and 150 units**. The view shows **4 and 130**. Event 2 is worth 20 and its device no longer matches. The view drops it in an inner join. The coverage check can show it as unattributed while keeping it in the total.

- Open **Data catalog → Relationships and lineage** to see which tables the view uses. Under **History and invalidated observations**, compare the first join check with the failed recheck.
- Open **View metric evidence** below the answer to see the filter, SQL and unmatched count.

<details>
<summary>See screenshots from the demo</summary>

![Metric evidence shows one unattributed event worth 20](../docs/images/missing-record-evidence.png)

![The old relationship shows its original and failed checks](../docs/images/why-memory-expired.png)

</details>

## Finish the demo

```sh
dsh plugin --profile web exec stellane-demo verify
dsh plugin --profile web exec stellane-demo stop
```

`verify` checks the expected values for the fixture's current state. `stop` keeps the data for the next `start`. Use `reset` to restore the demo tables, then recheck saved relationships. Use the same `STELLANE_DEMO_HOME` in a new terminal.

If you resume an older demo with two datasets, run `reset` when prompted, then `start` again. This resets telemetry and removes the retired support fixture from that demo database.

[Branch verification and expected values](../DEVELOPMENT.md#真实分支对照)

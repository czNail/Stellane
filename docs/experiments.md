# Rehearse a duplicate-order repair on branches

[中文](experiments.zh-CN.md) · [Find and reuse a relationship](../examples/README.md) · [Home](../README.md)

Suppose an import left duplicate historical orders. One record is newer, while another matches the payment ledger. Removing a duplicate changes more than the order table. You also need to decide where to point its payments and refunds, then check the reports that use those records.

## Check the candidates before branching

Start with read-only queries to list duplicate groups and see which rows each rule would keep. If all you need is a count or a comparison of filters, that can be enough. A transaction in a test database can also cover a small, immediate check. Branches are useful here because each proposal changes several tables, existing queries need to read the changed data, and a reviewer needs to reopen each result later.

Use the PostgreSQL view dependencies to find the tables behind the reports you plan to check. Use business definitions for the order key and the payment and refund rules. Check the actual joins for missing orders and payments that would be counted more than once.

## Run two proposals from the same baseline

Save one read-only baseline and record the order range and reports to check. Create two Stello work branches from that baseline.

| Experiment | Apply this change | Check this risk |
| --- | --- | --- |
| A · Keep the newest order | Pick the row by update time. Repoint payments and refunds, then remove the duplicate orders. | A retry may have created the newest row. Would this lose the payment status, channel or other attributes from the original order? |
| B · Keep the order that reconciles to payment | Prefer the row that matches the payment ledger. Repoint references from the duplicate rows and flag groups that still conflict. | Which duplicates can be resolved automatically? Which groups still need a human decision? |

Run the same checks on both branches. Count remaining duplicates, reconcile payments and refunds separately, look for broken references, and rerun the existing reports. Suppose the newest row says “organic” while the one that matches the payment says “paid ads.” The refund total can match on both branches while the channel report changes. Keep the edits and discrepancies so a reviewer can check the attribution before choosing a rule.

## Try the workflow in 0.1

In an ordinary DSH chat, the agent can save one baseline and start named experiments from it. It applies each proposal one SQL step at a time and saves the results and evidence. The source build groups plans from the same baseline in **Branch experiments**, with a link below the answer. With npm `0.1.0`, open **Activity and results**. When you no longer need retained results, remove them before their baseline in **Management → Retained branches**.

With a dedicated order test database, give the agent the confirmed duplicate rule, the allowed changes and the reports to check. For example:

> Save one baseline of the test data. Compare keeping the newest order with keeping the order that reconciles to payment. Apply each repair only on its assigned branch. Repoint payment and refund references, then run the same checks and reports on both. Include the evidence for any ambiguous groups.

The order example shows how to design the rehearsal. The repository's [runnable branch walkthrough](../DEVELOPMENT.md#真实分支对照) uses a small fixture to check isolation, retained results and cleanup. Launching multiple subagents from one request and collecting their results is part of the [proposed product design](../PRODUCT.md#多个子代理怎样分工).

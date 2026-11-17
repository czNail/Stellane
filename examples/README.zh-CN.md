# 跟着做一次数据排查

[English](README.md) · [安装 Stellane](../README.zh-CN.md#安装后直接提问) · [去试分支](../docs/experiments.zh-CN.md)

这次要查清一件事。**明细表有 150，报表为什么只算了 130？** 先复现一切正常时的报表，再让一条设备关联失效，看看 Stellane 能否指出漏掉的是哪条。这个演示使用 PostgreSQL 和合成数据。

## 接入演示库

装好 Stellane，启动 Docker，在运行 DSH 的机器上执行：

```sh
export STELLANE_DEMO_HOME="$HOME/Temp/stellane-demo"
dsh plugin --profile web exec stellane-demo start
dsh plugin --profile web exec stellane-demo url
```

1. 在 **Stellane → 数据源 → 添加数据源** 选择 **PostgreSQL**，粘贴第二条命令输出的连接 URL。
2. 项目目录使用 `start` 输出的 **Project** 路径，名称可填 `Stellane demo`，然后点 **连接并开始使用**。
3. 在连接卡片点 **在项目中提问**。后面另开会话时，选同一个 DSH 项目。

## 1. 看报表从哪来，核对它怎么关联

> 使用 `stellane_demo_telemetry`。告诉我报表视图 `active_event_totals` 用了哪些表。另查明细表，按区域数一数 active 事件，核对关联覆盖，保存有证据的表关系。

在 **数据目录 → 关系与血缘** 可以看到两类信息：

| 看哪里 | 回答什么 |
| --- | --- |
| `active_event_totals` 的视图血缘 | PostgreSQL 目录记录了视图引用的表和字段。这个视图用到事件表 `event_log`、设备表 `device_inventory` 和区域表 `zone_registry`。 |
| 已验证的关联 | 查实际数据，看看事件的设备标识能否匹配设备表，设备的区域标识能否匹配区域表。这套数据未声明外键，所以这些发现来自数据检查。 |

预期结果为 **North 4 条、South 1 条，共 5 条**。在同一项目新开一个对话：

> 用上次查到的关联按区域统计 active 事件的 magnitude 合计，请先复核关系现在是否适用。

预期为 **North 110、South 40，共 150**。这次对话可以从已保存的两段关联继续，先检查再使用。

## 2. 改一条记录，看看报表少了什么

保留连接和已查到的关系，在同一终端运行：

```sh
dsh plugin --profile web exec stellane-demo drift telemetry
```

再新开一个普通对话：

> 在 `stellane_demo_telemetry` 里，比较 `active_event_totals` 和从明细统计的 active 事件数及 magnitude 合计。用 Stellane 的指标检查列出无法归属的记录，说明在哪一步少算，并给我可打开的证据。

| 区域 | 事件数 | magnitude 合计 |
| --- | ---: | ---: |
| North | 3 | 90 |
| South | 1 | 40 |
| 未归因 | 1 | 20 |
| **合计** | **5** | **150** |

事件 2 的设备标识现在找不到对应设备。旧报表视图用了内连接，只算出 **4 条、130**。能解释差异的答案会把这条事件单独列出，同时保留在总量里。

- 点回答下方的 **查看指标证据**，找 active 筛选、SQL 以及哪段关联少匹配了 1 条。
- 在 **数据目录 → 关系与血缘 → 历史与失效记录** 展开旧关联，对照原验证和本次复核，看它为何失效。

<details>
<summary>看实际面板截图</summary>

![指标证据中有 1 条未归因事件，合计 20](../docs/images/missing-record-evidence.png)

![历史关系里同时保留原验证和本次未匹配检查](../docs/images/why-memory-expired.png)

</details>

这类排查适用于任何按关联表分组的报表，比如订单按渠道、库存按仓库、工单按团队。关键是从报表追到它依赖的表，再按当前数据复核关联。

## 3. 想试不同改法时，换用 Stello 分支

把那条事件归到 North 还是 South，会改变分组结果。可以从同一份数据分别试两种写法，然后核对结果。普通 PostgreSQL 演示库用于前两步的只读排查，试验分支另接 Stello。[查看分支做法和四子代理设计](../docs/experiments.zh-CN.md)。

## 演示结束后

```sh
dsh plugin --profile web exec stellane-demo verify telemetry
dsh plugin --profile web exec stellane-demo stop
```

`verify` 把当前数据与样例预期对照。`stop` 停止容器并保留数据，`start` 可以继续。需要从头重做时用 `reset` 恢复演示表，再重新验证已保存的关系。下次运行前设置相同的 `STELLANE_DEMO_HOME`。

已有专用演示库时，也可用 [telemetry SQL](datasets/telemetry/README.md) 初始化数据，再用只读角色连接。[查看实测结果](../docs/release-status.zh-CN.md)。

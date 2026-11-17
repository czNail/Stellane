# 查过一次，下次从已验证的关系接着查

[English](README.md) · [安装 Stellane](../README.zh-CN.md#安装后直接提问) · [分支预演](../docs/experiments.zh-CN.md)

这个可运行的 PostgreSQL 样例有事件、设备、区域三张表，表之间没有外键。你会先找出事件怎样归到区域，再在新对话中使用已保存的关系和人工确认的业务口径，最后改一条样例数据，看旧关系怎样失效。

## 接入演示库

装好 Stellane，启动 Docker，在运行 DSH 的机器上执行：

```sh
export STELLANE_DEMO_HOME="$HOME/Temp/stellane-demo"
dsh plugin --profile web exec stellane-demo start
dsh plugin --profile web exec stellane-demo url
```

1. 在 **Stellane → 数据源 → 添加数据源** 选择 **PostgreSQL**，粘贴第二条命令输出的连接 URL。
2. 项目目录使用 `start` 输出的 **Project** 路径，名称可填 `Stellane demo`，然后点 **连接并开始使用**。
3. 在连接卡片点 **在项目中提问**。另开对话时选同一个 DSH 项目。

## 1. 从问题出发，找表和关联

> 使用 `stellane_demo_telemetry`，按区域统计有效事件数。本例有效事件是状态为 active 的事件。请查清一条事件怎么找到所属区域，核对关联是否覆盖这些事件，保存查证过的关系。

预期为 **North 4 条、South 1 条，共 5 条**。在 **数据目录 → 关系与血缘** 看 Agent 查过的两段关联。事件里的设备标识要能找到设备，设备的区域标识要能找到区域。这些是对数据的实际检查，证据会说明检查范围内有多少行没匹配上。

## 2. 存下确认过的业务词，再开一个对话

继续在普通对话告诉 Agent：

> 记住「可计量事件」这个口径。它是 `stellane_demo_telemetry.event_log` 中 `state = 'active'` 的记录，每行代表一次事件，读数取 `magnitude`。

在源码版，核对回答下方的说明与数据表，点 **保存业务说明**。使用 npm `0.1.0` 时，在 **数据目录 → 业务说明 → 添加说明** 填写同样的含义并选择对应数据表。保存后另开同项目的对话：

> 按区域汇总可计量事件的读数。使用已保存的业务说明，先核对上次查明的关系，再给我查询依据。

预期为 **North 110、South 40，共 150**。业务说明告诉 Agent 要找哪些行、用哪个字段，已验证的关系帮助它找到区域。

## 3. 数据变了，看旧经验哪里失效

保留连接和上述记录，在同一终端执行：

```sh
dsh plugin --profile web exec stellane-demo drift
```

再新开一个普通对话：

> 核对 `active_event_totals` 和明细里可计量事件的总数、读数合计。用 Stellane 的指标检查列出未归因的记录，告诉我在哪一步少算，并给我可打开的证据。

明细仍然是 **5 条、150**，但视图只算出 **4 条、130**。事件 2 的读数是 20，现在找不到对应的设备。视图的内连接丢掉了它，覆盖检查可以把它列为未归因，保留在总量里。

- 在 **数据目录 → 关系与血缘** 看视图引用了哪些上游表，再展开 **历史与失效记录**，对照旧的关联验证和这次复核。
- 点回答下方的 **查看指标证据**，看实际筛选条件、SQL 和未匹配的数量。

<details>
<summary>看实际面板截图</summary>

![指标证据中有 1 条未归因事件，合计 20](../docs/images/missing-record-evidence.png)

![历史关系里保留了原验证和本次未匹配检查](../docs/images/why-memory-expired.png)

</details>

## 演示结束后

```sh
dsh plugin --profile web exec stellane-demo verify
dsh plugin --profile web exec stellane-demo stop
```

`verify` 核对当前样例的预期结果。`stop` 停止容器并保留数据，`start` 可以继续。若要从头重做，用 `reset` 恢复演示表，再重新验证关系。在新终端使用同一个 `STELLANE_DEMO_HOME`。

恢复旧版的双数据集演示时，按提示运行 `reset`，再运行 `start`。这会还原事件样例，并从该演示库删除旧工单样例。

[分支验收和预期值](../DEVELOPMENT.md#真实分支对照)

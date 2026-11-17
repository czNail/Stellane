# 开发与验证

日常使用见 [中文入门](README.zh-CN.md)或 [English quick start](README.md)，产品取舍见 [PRODUCT.md](PRODUCT.md)。这里说明实现边界、接口和可重复的验证方法。

## 当前能力

Core 在 Harness Host 内运行，面向 DeepSeek Harness Web `0.2.2-rc.1–rc.3`，开发依赖固定为 rc.3：

- PostgreSQL / Neon 连接 URL 一次接入，测试连接后自动建立实时只读环境。
- 普通项目对话使用内置 Skill 查目录、查数据、复用关系和启动受支持的实验。
- Neon 管理 API 和 Stello 分支接入，支持隔离的 DDL / DML 事务与持久回执；各自的数据状态保证见下文。
- 环境来源树、实际资源身份、执行历史和实验结果交付。
- 项目访问检查、同次调用去重、未知操作核对与重启后的记录恢复。
- 语义目录、业务说明表单与 JSON 批量导入、定义版本与历史、结构依赖检查，以及 `stellane_context` 检索。
- 数据关系与血缘，支持从目录读取视图依赖，并自动核对、保存和检索隐性键与关联。
- 同一语句快照下的指标总量与关联覆盖，聊天证据入口、失效原因及同口径修复试算。

探索记忆首版覆盖行粒度、相等关联和直接视图血缘。后续扩展实体概念、输出列的转换映射和外部任务血缘。

## 构建与安装

需要 Node.js 24.9+、Corepack，包管理器固定为 pnpm 11.1.2。

```sh
corepack pnpm install
corepack pnpm check
dsh plugin --profile web add "$PWD"
```

构建输出为 `dist/`。源码变更后重新构建并重启使用该插件的 Host。终端启动的 Web Host 可停止原进程后重新运行 `dsh web`；地址由 Harness 打印并自动在浏览器打开。远端运行可用 `dsh web --no-open`。自定义 profile 请将安装与启动命令中的 `web` 替换为同一个名称。

插件使用 DSH 原生工具、Skill、会话身份、远程调用和面板扩展接口。接入凭据仅由 Host 使用。不要把模型 API 配置混入数据库连接配置；模型沿用 DSH 已配置的提供方。

## 开发数据库

### PostgreSQL

```sh
corepack pnpm dev:db
corepack pnpm test:integration
corepack pnpm dev:db stop
```

脚本管理带所属标识的 `stellane-phase1-postgres` 容器和数据卷，只绑定 `127.0.0.1` 的随机端口。连接字段位于 `.stellane-dev/connection.json`，读取角色对测试表只有 SELECT 权限。

测试表 `sample_data(id, label, value, group_name)` 包含 3 条通用记录，数值为 120、80、160，用于验证参数查询、权限、继承与隔离。

### Neon

普通 Neon PostgreSQL URL 具备查询、目录、血缘和记忆能力，不必配置管理 API。0.1 的分支验收使用 Stello。开发者可用实验性的 Docker Neon 环境尝试本地分支：

```sh
corepack pnpm dev:neon start
corepack pnpm dev:neon status
STELLANE_NEON_LOCAL_CONFIG="$PWD/.stellane-dev/neon-local/provider.json" corepack pnpm test:neon:local
corepack pnpm dev:neon stop
```

在「添加数据源」选 **Neon (Docker)**，导入输出的 `provider.json` 绝对路径。详细的架构、实例隔离、样例导入和恢复步骤见[本地 Neon 指南](docs/local-neon.zh-CN.md)。这是 Stellane 的本地开发控制器，不是 Neon 官方云管理面，也不是依赖云项目的 Neon Local 代理。服务是实际的 pageserver、broker、safekeeper 和 compute；单节点环境不提供高可用保证。

适配器保存项目、分支、创建时间、来源位置、重置时间和 compute 身份。来源在 Stellane 中只读，写入仅在插件派生的工作分支。基线与结果的只读管理不等于外部管理员无法更改，因此记忆使用前仍复核。保留结果可能依赖父 timeline；结束实验关闭临时 compute，保留必要存储。「管理与清理 → 保留的分支」显示原因，按先子后父回收。Docker timeline 占本机磁盘。

`pnpm test:neon` 是无外部凭据的 API 契约测试；`test:neon:local` 是真实本地 A/B 与产品清理验收，环境不可用时失败，不会跳过。云端 `test:neon:live` 缺少 `STELLANE_NEON_CONFIG` 时明确跳过，不能当作通过。失败保留原状态、报告和删除意图，先核对原操作，不要重新跑一轮替代恢复。

Neon 云端 API 适配器仍是实验性入口，不属于 0.1 运行验收范围。如已有专用云测试资源，可自行提供 JSON：`name`、已存在的绝对 `projectPath`、`projectId`、`branchId`、`database`、`user`、`apiKeyRef`（`env:` 或私有 `file:` 引用）。不要设置 `localEndpoint`；显式将此配置交给 `STELLANE_NEON_CONFIG` 才会访问云端。云端会占用相应分支、compute 和存储额度，本地成功不能替代云端验收。

### Stello

需要 Linux、Docker 和已经构建的 Stello PG14 产物。

```sh
corepack pnpm dev:stello --source /path/to/Stello
corepack pnpm test:stello
corepack pnpm dev:stello stop
```

安装目录默认为 Stello 仓库的 `build-layout/pg14-current/install`，可用 `--prefix /path/to/install` 指定。脚本复制构建副本到专用状态目录，创建独立的 systemd 主机容器、RustFS 容器和内部网络；构建来源记录在 `build.json`。

默认登记字段为 `.stellane-dev/stello/provider.json`，默认资源为 `stellane-phase2-host`、`stellane-phase2-objects` 和 `stellane-phase2` 网络。默认 8 个 Compute 槽位，每槽位 512 MiB 内存、1 GiB 磁盘，主机上限 6 GiB / 4 CPU，对象存储上限 1 GiB。使用 `--slots 16` 时，主机与对象存储上限分别为 10 GiB 和 2 GiB。

集成测试需空闲槽位。可用独立实例运行，避免干扰保留的探索环境：

```sh
corepack pnpm dev:stello --instance context-check --slots 8 \
  --project "$PWD/.stellane-dev/context-check-project" --source /path/to/Stello
STELLANE_STELLO_CONFIG="$PWD/.stellane-dev/stello-context-check/provider.json" \
  corepack pnpm test:stello
corepack pnpm dev:stello stop --instance context-check
```

自定义实例的状态位于 `.stellane-dev/stello-<instance>`，资源名称和所属标识为 `stellane-<instance>`。脚本核对所属标识，只管理自身资源。`stop` 先让 Stello 保存运行清单，再停止容器。`start` 恢复原有部署，并通过实际 SQL 检查验收来源就绪。测试只回收自身创建且身份匹配的分支，保留基线。

## 普通对话、SQL 与分支

1. 在「数据源」粘贴 PostgreSQL / Neon 连接 URL，连接成功即可在同一项目普通对话里使用。Neon API 和 Stello 来源另提供分支能力。
2. 直接问表关系、指标或血缘，Agent 按需加载 `stellane-data`，执行只读查询并记录证据。需要手写 SQL 时使用「探索」。
3. 用户要求模拟改动时，Agent 在有分支能力的来源上创建任务、准备基线、派生工作分支。普通 PostgreSQL 分析不依赖这些步骤。
4. 在工作分支提交单条 DDL / DML，核验结果。来源库不接受这些写入。
5. 保存结果摘要和只读证据。指标修复任务自动沿用原计划，计算基线与结果；普通实验提供证据 SQL。
6. 交付后结束任务，按提供方能力清理临时资源或说明保留原因。固定结果保证和只读分支保证分别展示。

已提交的持久状态随分支继承；SQL 会话、临时表、未提交事务和外部文件不继承。

普通对话和工作台的「开始实验」使用同一任务流程。「任务与结果」提供进度、返回原对话、SQL、结果、原操作核对和清理。证据查询失败时保留已创建的结果环境，之后在原环境补查。Stello 回收工作分支及本任务创建的基线，保留已交付的固定切面；Neon 按上文保留依赖链并关闭临时 compute。待核实的写入保留原分支，直至核对回执。

工作台发起的对话先通过 Harness 创建独立 Session，再由 Host 校验项目并绑定环境。工具识别 Harness 提供的会话身份。初版授权给任务的根对话，任务分支对同项目其他会话保持私有。管理请求和 SQL 连接仍由 Host 执行。

| 工具 | 用途 |
| --- | --- |
| `stellane_context` | 检索相关元数据、业务说明、数据关系和视图血缘 |
| `stellane_environments` / `stellane_query` | 当前项目环境与只读查询 |
| `stellane_learn` | 核对并保存行键或相等关联，也用于重新验证历史观察 |
| `stellane_metric` | 按已保存关系链计算指标并记录总量、覆盖及未归因证据 |
| `stellane_start_experiment` / `stellane_experiments` | 在普通对话开始实验、查询本会话任务和进度 |
| `stellane_capture_experiment` / `stellane_finish_experiment` | 保存实验结果、结束并清理或说明保留 |
| `stellane_checkpoint` / `stellane_fork` | 创建基线、派生可写环境；数据保证由提供方决定 |
| `stellane_execute` | 单条 SQL 事务与回执 |
| `stellane_deliver` / `stellane_results` | 结果交付与读取 |
| `stellane_reconcile_write` / `stellane_reconcile_branch` | 观察原回执或原分支，不重放操作 |

## 语义目录与上下文

在“数据目录”查看当前环境的表与字段、业务说明、关系与血缘。在“业务说明”添加定义或导入 JSON。“编辑说明”自动携带当前版本条件，保存时保留历史。

“预览参考资料”展示与 Agent 相同的检索结果；“去对话中提问”打开带有问题的新对话，发送后才执行查询。数据来源、结构指纹和校验记录可按需展开。

已有业务词典可通过“批量导入 JSON”读取本地文件或粘贴以下格式：

```json
{
  "source": { "name": "指标词典", "uri": "docs/metrics.json" },
  "entries": [{
    "key": "sample.total",
    "title": "总指标值",
    "kind": "metric",
    "content": "按 group_name 对 value 求和，单位为点。",
    "targets": [{ "schema": "public", "table": "sample_data", "columns": ["value", "group_name"] }],
    "sql": "SELECT group_name, SUM(value) FROM public.sample_data GROUP BY group_name",
    "expectedVersion": 0
  }]
}
```

`kind` 支持 `description`、`metric`、`relationship` 和 `sql-example`。`uri` 是来源引用，不自动读取外部文件或网址。首次导入版本条件为 0，更新填写当前版本号；同次请求去重，版本冲突或结构变化会拒绝更新，整批文档在 SQLite 事务内保存。

每次 `stellane_context` 调用都在一条只读 SQL 中读取当前 SQL 角色有整表 SELECT 权限的用户对象，包括字段、默认值、生成与身份属性、注释、约束和视图定义。结构变化、注释变化、对象重建或依赖不可见会排除对应定义；新版本也会替代旧版本，不回退到旧定义。检索使用关键词和中文相邻双字匹配，相关外键目标一并纳入有界结果。

普通 PG 和仅通过连接 URL 接入的 Neon 以连接登记及实际目标作为来源依据，这不是不可替换的物理实例证明。Neon API 接入另外核对项目与分支身份、创建时间和重置信息；Stello 核对原资源身份和来源，固定切面返回固定位置，可写分支的 forkLsn 仅表示起始来源。结构指纹与 MVCC 观测不代表数据内容版本。定义共享仍要满足同一数据来源和结构依赖，新连接登记默认隔离。

返回值包含上下文 ID、实际目标、观测时间、结构与目录指纹、来源定义、被排除版本及原因、元数据执行记录。上下文保存本次问题和选中的定义版本、对象 ID，便于追溯 Agent 实际获得的资料。传入同环境的 `previousContextId` 可比较结构和定义是否变化。完整历史和导入仅供用户访问，Agent 读取当前适用内容；SQL 示例不会自动执行。

元数据读取保存为 `purpose: context` 的执行证据，不占用面板的业务 SQL 查询历史。

初版上限：64 个可读对象，每对象 256 个字段、128 条约束，元数据响应 128 KiB；每文档 64 KiB / 16 条定义，每数据源最多 128 个未归档定义版本（包括未归档历史）；归档释放此容量并保留证据，单次检索最多返回 16 个对象及 16 条定义。超限时明确失败，不把部分元数据当作完整目录。

## 探索记忆

在普通项目对话向 Agent 询问表的粒度、可用关联或视图来源。在“数据目录 → 关系与血缘”查看关联字段、基数、来源和验证时间。

`stellane_context` 返回可读对象间的直接视图依赖。上游列是视图引用的字段，包含连接、筛选等用途。沿多条依赖可以看到视图链路。证据来自 [PostgreSQL 依赖目录](https://www.postgresql.org/docs/14/catalog-pg-depend.html)和[视图重写规则](https://www.postgresql.org/docs/14/catalog-pg-rewrite.html)。

`stellane_learn` 接收 `environmentId` 和结构化 `claim`。`row-key` 接收 `target`。`join` 接收 `from`、`to`，按列顺序对应相等条件。每个对象指定 `schema`、`table`、`columns`。系统生成只读检查 SQL，在同一条语句中读取结构和检查结果。行键要求有数据、键非空且唯一。关联要求来源键非空、目标键非空且唯一、来源记录全部匹配。基数描述来源到目标的匹配范围，目标表可以有未被引用的行。

通过后自动保存，按项目与环境共享。证据记录实际对象、执行记录、观测时间与快照。Stello 固定切面可以读取适用观察。实时库、可写分支和 Neon 只读分支的观察标为 `needs-check`，沿用前调用同一条 `stellane_learn`。重新核对失败时，旧观察退出正常检索；失效关系另记录原因与原、新证据，供指标工具复核已知路径。对象结构、权限或资源身份变化也会排除旧观察。

首版检查无子表且未启用行级安全的普通表，支持最多 8 列的复合键和常见内建标量类型。每环境最多保存 128 个未归档观察版本；归档后停止复用并释放容量，历史证据仍保留。视图目录读取最多 256 条可见依赖。目录读取和关系检查各受 5 秒只读 SQL 时限和预览大小限制。

## 指标与修复证据

`stellane_metric` 接收环境、名称、连续且有序的关系 ID、分组字段、可选求和字段与一个可选等值筛选。当前支持 1–4 段等值关联。Core 根据授权范围内的已保存关系生成单条只读 SQL，在同一语句快照内取得分组、总量与逐段覆盖。

关系目标键不唯一时不会把放大的结果当成正确总量。缺失关联保留为未归因分组；多义、缺失数值或不完整证明使指标标为待核实。指标检查在同环境发现反例时，会直接使旧的完整关联记忆失效并记录本次指标范围；该范围证据与整表关系 profile 分开显示，不把筛选后的数量称为整表检查。结果带计算计划、稳定口径版本、引用关系与执行记录。名字变化不改变口径版本。

从指标证据发起修复，`stellane_start_experiment` 的 `metricRunId` 绑定原计划。系统在基线与交付结果上执行同一计划并保存两份证据，`stellane_capture_experiment` 此时可省略 SQL。任务内对原关系的继承仅限这个已授权计划，不开放任意跨环境关系访问。去重、比例等其他口径走普通 SQL。

## 身份、凭据与失败处理

连接向导接收 URL，Host 保存密码后只持久化引用，SQL 和 Agent 工具不接收连接密码。高级方式的普通 PG 密码引用支持 `env:VARIABLE_NAME` 和 `file:/absolute/path`。凭据文件须为仅当前用户可访问的普通文件，权限 `600`、上限 8 KiB。连接只保存引用；修改配置生成新连接身份。

Neon API key 同样只保存引用，连接 URI 在 Host 内临时使用。Stello 使用 `stello context export` 导出的 HTTPS 入口、CA 和令牌文件引用，相对路径按配置文件目录解析。管理凭据与 SQL 凭据由 Host 使用，云端连接验证服务器证书。SQLite 不保存凭据正文。

Agent 身份、调用 ID 和项目目录来自 Harness 执行上下文；Core 检查项目归属与读写权限，数据库角色继续限制 SQL。管理界面仅限 Host 所有者。来源与结果在插件中只读，写入限本插件派生的可写分支。

每次连接核对 Stello 服务、槽位、代次与资源 ID。同名重建不能替代旧环境，派生记录保存原准入、创建标识、父身份与实际固定位置。

插件的绝对路径 `stateDirectory` 优先；未设置时先沿用已有的 `~/.local/share/stellane/state.sqlite`，全新安装才使用 DSH profile 下的 `stellane-state`（无 profile 信息时回退旧路径）。目录 `700`、文件 `600`。状态格式为 7，升级前在 `backups/` 保存包含 WAL 已提交数据的一致快照。单目录用 `owner.sqlite` 排他锁防止多 Host 写入，进程退出即释放，不能删锁绕过。早期开发版没有新格式守卫，升级前必须停止，不能直接降级读新版状态。完整步骤见[维护指南](docs/install-and-maintain.zh-CN.md)。

管理页允许所有者停用 / 启用来源、验证后轮换凭据、归档记忆与定义、精确回收保留分支、移除连接，或明确确认删除来源的本地资料与历史。停用拦截新操作，但保留证据和原操作收尾。移除 / 删除需要先处理活动、未知操作与保留资源。来源数据库和用户外部凭据永远不删，归档与连接移除保留证据；删除本地历史也不清理备份、DSH 聊天或模型方日志。

- 单条 SQL 最多 16 KiB、32 个标量参数；预览最多 200 行、128 KiB。只读查询限时 5 秒，写入事务中的语句限时 30 秒。
- 每个 Core 最多 4 个并发操作，每项目最多 16 个环境，包含待核实派生。单环境写入与固定互斥，同一数据库的派生准入串行，兄弟分支 SQL 可并行。
- 写入拒绝多语句、事务控制、SET 和 CALL；数据修改与回执在同一事务提交。`stellane_internal` 为回执保留命名空间。
- 同一调用 ID 或请求 ID 返回原记录，改变原输入会被拒绝。已确认回滚为失败，提交结果未确认则为未知。
- 重启后未完成写入与派生转为待核实，只读查询转为中断。核对只观察原回执或原资源；无证据时继续保留未知。
- Stello 派生已准入后返回忙碌时，只观察同一票据的完成状态，不发送第二次创建请求。
- Neon 创建响应丢失时按原操作和资源核对，未找到不能证明创建未发生，不自动重发 POST。删除只针对身份匹配的插件资源，异步操作完成后才报告完成。

## 演示数据与多路径验收

想在 DSH 里体验关系复用和失效复核，从[可运行演示](examples/README.zh-CN.md)开始。想判断业务改动是否值得用分支，见[订单去重预演](docs/experiments.zh-CN.md)。下面用带固定预期的合成数据验证功能，测试规则都随样例发布。

三个入口服务于不同的验证目的：

| 入口 | 使用的资源 | 验证内容 |
| --- | --- | --- |
| `pnpm demo start` | 独立演示容器、只读连接和演示项目 | 在 DSH 普通对话中发现关系、复用记忆、观察失效与面板证据 |
| `pnpm dev:db` 后运行 `pnpm test:demo` | 开发数据库中的测试专属 schema；不连接演示容器 | 公开 SQL、独立预期数值、Core 记忆与失效行为 |
| `pnpm demo:branches` | 已配置的专用 Neon 或 Stello 来源 | 真实分支中的共同起点、方案隔离、保留结果与清理 |

### 普通对话演练

```sh
export STELLANE_DEMO_HOME="$HOME/Temp/stellane-demo"
corepack pnpm demo start
corepack pnpm demo url
corepack pnpm demo status
```

按输出接入私有连接 URL，并在输出的项目目录新建普通对话。跟随演示指南逐步提问。用 `pnpm demo drift` 制造受控变化，再到新对话验证旧关系是否被复核。用 `pnpm demo verify` 核对样例数值，在面板另行检查 Agent 实际使用的关系和证据。

`pnpm demo reset` 只重建演示 schema，`pnpm demo stop` 停止演示容器并保留数据。重新 `start` 可恢复原数据。这些命令与 `dev:db` 各自管理带所属标记的资源，不能混用两者的连接文件。

### 数据与记忆回归

```sh
corepack pnpm dev:db
corepack pnpm test:demo
corepack pnpm dev:db stop
```

测试读取 `examples/datasets/telemetry/` 的初始化、受控变更、A/B 方案 SQL 和 `manifest.json`，核对指标、视图血缘、跨对话与重启后的记忆检索，以及变更后的旧关系失效。测试只清理自己成功创建的 schema。若同名 schema 已存在，测试会拒绝覆盖。

此处用事务回滚分别核对 A/B SQL 的数值，不把它视为数据库分支隔离验收。`test:integration` 已包含这组测试，只有单独检查演示数据时才需要再运行 `test:demo`。

### 真实分支对照

准备[专用 Stello 测试来源](#stello)。在 `~/Temp` 的独立检出构建 Stellane，用有建表权限的测试连接执行下面的命令。把 `stellane_demo` 换成已在本地配置的 psql 服务名。初始化文件创建专用 schema，第二条导入会把事件 2 的设备标识换成无法匹配的值。

```sh
psql service=stellane_demo -v ON_ERROR_STOP=1 -f examples/datasets/telemetry/setup.sql
psql service=stellane_demo -v ON_ERROR_STOP=1 -f examples/datasets/telemetry/drift.sql

mkdir -p "$HOME/Temp/stellane-branches"
run_dir="$HOME/Temp/stellane-branches/telemetry-$(date +%Y%m%d-%H%M%S)"
corepack pnpm demo:branches --stello /absolute/path/provider.json --state-dir "$run_dir"
```

验收时核对两项任务引用同一基线、A 的写入不改变 B、两份结果使用同一口径，以及来源数据指纹保持一致。脚本直接调用 Core 并使用已知方案 SQL，验证的是分支状态与结果。各组的结果为事件数 / 读数合计。

| 阶段 | North | South | 未归因 | 合计 |
| --- | --- | --- | --- | --- |
| 导入 `setup.sql` | 4 / 110 | 1 / 40 | 0 / 0 | 5 / 150 |
| 执行 `drift.sql` 后的共同基线 | 3 / 90 | 1 / 40 | 1 / 20 | 5 / 150 |
| A 将事件 2 关联至 `device-a` | 4 / 110 | 1 / 40 | 0 / 0 | 5 / 150 |
| B 将事件 2 关联至 `device-c` | 3 / 90 | 2 / 60 | 0 / 0 | 5 / 150 |

成功运行会打印私有状态目录，保留报告、结果和共享基线。报告使用独立 Core 状态，不会自动进入现有 DSH 面板。检查后显式清理本次记录的资源：

```sh
corepack pnpm demo:branches status --state-dir /absolute/path/printed-run-directory
corepack pnpm demo:branches cleanup --state-dir /absolute/path/printed-run-directory
```

出现失败或结果未知时，用原目录核对分支身份和写入回执：

```sh
corepack pnpm demo:branches reconcile --state-dir /absolute/path/printed-run-directory
```

`reconcile` 只核对原操作。`reviewed` 表示已核对，可以回收，并不表示原实验通过。仍有未知结果时，检查提供方和原回执。清理中断后，再用同一目录执行 `cleanup`，沿用原删除记录。若崩溃留下 `runner.lock`，确认其中的进程已经退出后才可删除它。Core 的 `owner.sqlite` 保留。

脚本按身份从子到父回收本次资源，保留来源库和本地证据。试验 Neon 时需要另行接入实验性分支提供方，参见[本地 Neon 指南](docs/local-neon.zh-CN.md)。

要单独验证对话与面板，在 **数据源 → 添加数据源 → Stello** 填客户端配置文件、来源数据库和分支，再选 DSH 项目。在该项目的新对话里，让 Agent 从同一基线建两个实验，分别在各自分支把 `stellane_demo_telemetry` 的事件 2 归给 `device-a` 或 `device-c`，用同一查询汇总有效事件并保存证据。在 **任务与结果** 核对基线、SQL 和结果，完成后用 **管理与清理 → 保留的分支** 按依赖顺序回收。

## 检查与验收

```sh
corepack pnpm check
corepack pnpm test:integration
corepack pnpm test:neon
corepack pnpm test:stello
corepack pnpm test:package
```

`test:package` 构建 tgz，检查分发文件和私有文件排除，再在无源码的临时目录安装包，执行包内演示命令。CI 在 Ubuntu 的 Node 24.9.0 / 24.x 执行基础检查，另用真实 PostgreSQL 运行集成检查并上传已验证的 tgz。DSH rc.1 与 rc.3 的发行包安装 / UI 验收另行记录，不能由类型检查代替。

`check` 包含 Host / Client 类型检查、Core、连接向导、Neon 契约、状态迁移 / 互斥、管理生命周期测试和构建。PG 集成测试覆盖真实 SQL、参数、预览限制、只读拒绝和取消；`tests/community.test.ts` 另覆盖普通 PG 的跨对话关系复用、数据变化后的失效与指标证据。语义目录集成测试覆盖元数据与权限、自然语言关键词检索、定义更新与并发版本检查、数据变化和结构变化的区别、失效排除及重启保留。Stello 集成测试验证固定位置、分支观测和语义定义继承，以及持久状态继承、并发兄弟隔离、固定结果、嵌套派生、项目与资源身份检查、事务控制拒绝，以及重启后通过回执确认提交而不重放 SQL。

探索记忆测试覆盖视图链、复合键、多对一关系、跨 Agent 检索、失效、权限和重启保留。Stello 测试覆盖同项目任务隔离、证据失败后复用原切面、工作分支清理和重启后读取交付。报告保存在所选 `provider.json` 同目录的 `integration-report.json` 和 `experiment-report.json`。

### 手动产品验收

使用专用测试库和合成数据。对象名与业务定义可以替换，验证器的预期答案与 Agent 的查询分开编写。

1. **普通 PostgreSQL 独立验收。** 只提供连接 URL，连接后直接在普通项目对话提问。确认一次接入即可查询，目录、视图血缘和关系记忆不依赖 Neon API 或 Stello。
2. **跨对话记忆与变化。** 建两到三张有隐性等值关系的表和一个视图，首次查询让 Agent 验证并保存关联。新对话查询另一个指标，确认读到原关系且执行复核。由测试维护者修改来源数据，使一条关联失效，再开对话查询；检查未归因数量、旧关系失效原因和原、新证据。
3. **范围与权限。** 同项目的普通对话可访问共享来源；不同项目不可见。同项目其他会话不能读取某个任务的私有分支、执行记录或交付结果。源码或表结构变化后不能悄悄沿用旧定义。
4. **分支实验。** 对本地 Neon 来源和 Stello 分别保存一次共享基线，从同一基线创建 A/B 隔离试验，修改各自工作分支，用同一口径保存基线与方案证据。核对兄弟分支互不影响，独立查询来源确认原数据未变。模拟响应丢失或重启，验证原操作核对不会重复创建资源或写入。
5. **清理与保留。** Stello 归还临时工作资源并保留结果。Neon 显示保留父链的原因，临时 compute 与访问已关闭，保存结果仍有证据可查；没有结果时验证自有分支删除完成。
6. **管理。** 停用后 Agent 不可查询，但所有者能查看原证据和核对。轮换失败仍用原凭据，成功沿用证据；归档释放容量。按子先父回收准确身份的分支；移除连接保留历史，强确认删除本地资料后来源库保持不变。
7. **界面路径。** 从普通对话直接打开指标证据，核对覆盖状态；从失效关系打开两份验证；从实验查看进度、前后比较与清理状态。重启 Host 后历史记录仍存在。

保存测试提供方、版本、运行时间、独立预期答案、来源复查和资源状态。记录未执行的真实云端步骤，不把接口模拟或合成业务的单次收益写成生产保证。

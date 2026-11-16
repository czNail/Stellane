# 开发与验证

日常使用见 [中文入门](README.zh-CN.md)或 [English quick start](README.md)，产品取舍见 [PRODUCT.md](PRODUCT.md)。这里说明实现边界、接口和可重复的验证方法。

## 当前能力

Core 在 Harness Host 内运行，支持 DeepSeek Harness Web `0.2.2-rc.1`：

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

普通分析只需要 Neon 控制台提供的 PostgreSQL 连接 URL，使用与普通 PG 相同的只读 SQL、目录、血缘和记忆能力。连接向导的「启用独立试验」另接收项目 ID、来源分支 ID 和 API key；Host 将 API key 保存为私有凭据引用。

管理 API 使用 [Neon 官方 v2 接口](https://neon.com/docs/reference/api-reference)。适配器记录项目 ID、分支 ID、创建时间、父分支与来源位置、重置时间和 compute 身份。实验写入限于插件创建的工作分支。来源连接保持只读，基线和结果使用只读 compute；外部出现可写 compute 或分支被重置时拒绝沿用原状态。

Neon 的只读分支不提供与 Stello 固定切面相同的不可变保证。记忆始终需要在使用前复核。保留结果时，Neon 要求保留它依赖的父链；结束实验会关闭临时环境访问并删除基线/工作分支的 compute，保留必要的分支存储和结果。任务中保存 `retentionNote`，明确仍可能产生费用。没有交付结果的实验可按叶到根顺序删除自身分支。

本地 API 契约测试无需云端凭据：

```sh
corepack pnpm test:neon
```

契约测试验证请求、异步操作、身份核对和失败恢复。它没有创建真实 Neon 云资源。

真实云端验收另有显式入口 `pnpm test:neon:live`。先准备专用测试项目与来源分支，数据库角色须能在派生分支的 `public` schema 创建测试表，API key 须能管理该项目的分支和 compute。来源可以保持业务空库；脚本仅在自己创建的实验工作分支写入三行合成数据。项目应有至少三个可用分支名额，以及测试期间的 compute/存储额度。

在仓库外保存配置 JSON，`projectPath` 指向一个已存在的本地目录，`apiKeyRef` 引用 Host 环境变量或权限为 `600` 的凭据文件：

```json
{
  "name": "Neon live validation",
  "projectPath": "/absolute/path/to/test-project",
  "projectId": "your-neon-project-id",
  "branchId": "br-your-test-source",
  "database": "neondb",
  "user": "your-test-role",
  "apiKeyRef": "env:NEON_API_KEY"
}
```

配置好引用的凭据后执行：

```sh
STELLANE_NEON_CONFIG=/absolute/path/to/neon-test.json corepack pnpm test:neon:live
```

未设置 `STELLANE_NEON_CONFIG` 时，此测试明确显示 **skipped**。测试覆盖真实建分支、隔离写入、保存结果、来源没有测试表、兄弟会话拒绝访问、只读结果上的记忆仍需复核，以及结束实验后的保留说明。正常完成后，再按已记录的精确身份从叶到根删除本次测试的结果、工作和基线分支，保留配置的来源；这一步专用于测试资源收尾，不改变产品默认保留结果的行为。

任何步骤失败或结果未知都会保留临时目录中的 `state.sqlite`、`report.json` 与清理请求，输出待核对的目录路径。先核对原操作，再处理清理；不要以重新运行测试代替原操作恢复。测试可能产生 Neon 费用，失败保留的资源也可能继续计费。未提供真实凭据时，只能报告该入口跳过，不能宣称云端验收通过。

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

初版上限：64 个可读对象，每对象 256 个字段、128 条约束，元数据响应 128 KiB；每文档 64 KiB / 16 条定义，每数据源保留最多 128 个定义版本（含历史），单次检索最多返回 16 个对象及 16 条定义。超限时明确失败，不把部分元数据当作完整目录。

## 探索记忆

在普通项目对话向 Agent 询问表的粒度、可用关联或视图来源。在“数据目录 → 关系与血缘”查看关联字段、基数、来源和验证时间。

`stellane_context` 返回可读对象间的直接视图依赖。上游列是视图引用的字段，包含连接、筛选等用途。沿多条依赖可以看到视图链路。证据来自 [PostgreSQL 依赖目录](https://www.postgresql.org/docs/14/catalog-pg-depend.html)和[视图重写规则](https://www.postgresql.org/docs/14/catalog-pg-rewrite.html)。

`stellane_learn` 接收 `environmentId` 和结构化 `claim`。`row-key` 接收 `target`。`join` 接收 `from`、`to`，按列顺序对应相等条件。每个对象指定 `schema`、`table`、`columns`。系统生成只读检查 SQL，在同一条语句中读取结构和检查结果。行键要求有数据、键非空且唯一。关联要求来源键非空、目标键非空且唯一、来源记录全部匹配。基数描述来源到目标的匹配范围，目标表可以有未被引用的行。

通过后自动保存，按项目与环境共享。证据记录实际对象、执行记录、观测时间与快照。Stello 固定切面可以读取适用观察。实时库、可写分支和 Neon 只读分支的观察标为 `needs-check`，沿用前调用同一条 `stellane_learn`。重新核对失败时，旧观察退出正常检索；失效关系另记录原因与原、新证据，供指标工具复核已知路径。对象结构、权限或资源身份变化也会排除旧观察。

首版检查无子表且未启用行级安全的普通表，支持最多 8 列的复合键和常见内建标量类型。每环境最多保存 128 个观察版本。视图目录读取最多 256 条可见依赖。目录读取和关系检查各受 5 秒只读 SQL 时限和预览大小限制。

## 指标与修复证据

`stellane_metric` 接收环境、名称、连续且有序的关系 ID、分组字段、可选求和字段与一个可选等值筛选。当前支持 1–4 段等值关联。Core 根据授权范围内的已保存关系生成单条只读 SQL，在同一语句快照内取得分组、总量与逐段覆盖。

关系目标键不唯一时不会把放大的结果当成正确总量。缺失关联保留为未归因分组；多义、缺失数值或不完整证明使指标标为待核实。指标检查在同环境发现反例时，会直接使旧的完整关联记忆失效并记录本次指标范围；该范围证据与整表关系 profile 分开显示，不把筛选后的数量称为整表检查。结果带计算计划、稳定口径版本、引用关系与执行记录。名字变化不改变口径版本。

从指标证据发起修复，`stellane_start_experiment` 的 `metricRunId` 绑定原计划。系统在基线与交付结果上执行同一计划并保存两份证据，`stellane_capture_experiment` 此时可省略 SQL。任务内对原关系的继承仅限这个已授权计划，不开放任意跨环境关系访问。去重、比例等其他口径走普通 SQL。

## 身份、凭据与失败处理

连接向导接收 URL，Host 保存密码后只持久化引用，SQL 和 Agent 工具不接收连接密码。高级方式的普通 PG 密码引用支持 `env:VARIABLE_NAME` 和 `file:/absolute/path`。凭据文件须为仅当前用户可访问的普通文件，权限 `600`、上限 8 KiB。连接只保存引用；修改配置生成新连接身份。

Neon API key 同样只保存引用，连接 URI 在 Host 内临时使用。Stello 使用 `stello context export` 导出的 HTTPS 入口、CA 和令牌文件引用，相对路径按配置文件目录解析。管理凭据与 SQL 凭据由 Host 使用，云端连接验证服务器证书。SQLite 不保存凭据正文。

Agent 身份、调用 ID 和项目目录来自 Harness 执行上下文；Core 检查项目归属与读写权限，数据库角色继续限制 SQL。管理界面仅限 Host 所有者。来源与结果在插件中只读，写入限本插件派生的可写分支。

每次连接核对 Stello 服务、槽位、代次与资源 ID。同名重建不能替代旧环境，派生记录保存原准入、创建标识、父身份与实际固定位置。

本地状态默认为 `~/.local/share/stellane/state.sqlite`，目录 `700`、文件 `600`。插件的 `stateDirectory` 可指定其他绝对路径，单个 Host 管理一套状态。

- 单条 SQL 最多 16 KiB、32 个标量参数；预览最多 200 行、128 KiB。只读查询限时 5 秒，写入事务中的语句限时 30 秒。
- 每个 Core 最多 4 个并发操作，每项目最多 16 个环境，包含待核实派生。单环境写入与固定互斥，同一数据库的派生准入串行，兄弟分支 SQL 可并行。
- 写入拒绝多语句、事务控制、SET 和 CALL；数据修改与回执在同一事务提交。`stellane_internal` 为回执保留命名空间。
- 同一调用 ID 或请求 ID 返回原记录，改变原输入会被拒绝。已确认回滚为失败，提交结果未确认则为未知。
- 重启后未完成写入与派生转为待核实，只读查询转为中断。核对只观察原回执或原资源；无证据时继续保留未知。
- Stello 派生已准入后返回忙碌时，只观察同一票据的完成状态，不发送第二次创建请求。
- Neon 创建响应丢失时按原操作和资源核对，未找到不能证明创建未发生，不自动重发 POST。删除只针对身份匹配的插件资源，异步操作完成后才报告完成。

## 检查与验收

```sh
corepack pnpm check
corepack pnpm test:integration
corepack pnpm test:neon
corepack pnpm test:stello
```

`check` 包含 Host / Client 类型检查、Core、连接向导、Neon 契约测试和构建。PG 集成测试覆盖真实 SQL、参数、预览限制、只读拒绝和取消；`tests/community.test.ts` 另覆盖普通 PG 的跨对话关系复用、数据变化后的失效与指标证据。语义目录集成测试覆盖元数据与权限、自然语言关键词检索、定义更新与并发版本检查、数据变化和结构变化的区别、失效排除及重启保留。Stello 集成测试验证固定位置、分支观测和语义定义继承，以及持久状态继承、并发兄弟隔离、固定结果、嵌套派生、项目与资源身份检查、事务控制拒绝，以及重启后通过回执确认提交而不重放 SQL。

探索记忆测试覆盖视图链、复合键、多对一关系、跨 Agent 检索、失效、权限和重启保留。Stello 测试覆盖同项目任务隔离、证据失败后复用原切面、工作分支清理和重启后读取交付。报告保存在所选 `provider.json` 同目录的 `integration-report.json` 和 `experiment-report.json`。

### 手动产品验收

使用专用测试库和合成数据。对象名与业务定义可以替换，验证器的预期答案与 Agent 的查询分开编写。

1. **普通 PostgreSQL 独立验收。** 只提供连接 URL，连接后直接在普通项目对话提问。确认一次接入即可查询，目录、视图血缘和关系记忆不依赖 Neon API 或 Stello。
2. **跨对话记忆与变化。** 建两到三张有隐性等值关系的表和一个视图，首次查询让 Agent 验证并保存关联。新对话查询另一个指标，确认读到原关系且执行复核。由测试维护者修改来源数据，使一条关联失效，再开对话查询；检查未归因数量、旧关系失效原因和原、新证据。
3. **范围与权限。** 同项目的普通对话可访问共享来源；不同项目不可见。同项目其他会话不能读取某个任务的私有分支、执行记录或交付结果。源码或表结构变化后不能悄悄沿用旧定义。
4. **分支实验。** 对 Neon API 来源和 Stello 分别创建隔离试验，修改工作分支，保存前后证据。独立查询来源确认原数据未变。模拟响应丢失或重启，验证原操作核对不会重复创建资源或写入。
5. **清理与保留。** Stello 归还临时工作资源并保留结果。Neon 显示保留父链的原因，临时 compute 与访问已关闭，保存结果仍有证据可查；没有结果时验证自有分支删除完成。
6. **界面路径。** 从普通对话直接打开指标证据，核对覆盖状态；从失效关系打开两份验证；从实验查看进度、前后比较与清理状态。重启 Host 后历史记录仍存在。

保存测试提供方、版本、运行时间、独立预期答案、来源复查和资源状态。记录未执行的真实云端步骤，不把接口模拟或合成业务的单次收益写成生产保证。

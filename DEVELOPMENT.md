# 开发与验证

产品目标与开发顺序见 [PRODUCT.md](PRODUCT.md)。这里描述当前代码可运行的能力。

## 当前能力

Core 在 Harness Host 内运行，支持 DeepSeek Harness Web `0.2.2-rc.1`：

- PostgreSQL 连接登记、实时只读环境、面板与 Agent SQL 查询。
- Stello 来源登记、固定切面、可写分支、DDL / DML 事务与持久回执。
- 环境来源树、实际资源身份、执行历史和固定结果交付。
- 项目访问检查、同次调用去重、未知操作核对与重启后的记录恢复。
- 语义目录、业务说明表单与 JSON 批量导入、定义版本与历史、结构依赖检查，以及 `stellane_context` 检索。
- 数据关系与血缘，支持从目录读取视图依赖，并自动核对、保存和检索隐性键与关联。

探索记忆首版覆盖行粒度、相等关联和直接视图血缘。后续扩展实体概念、输出列的转换映射和外部任务血缘。

## 构建与安装

需要 Node.js 24.9+、Corepack，包管理器固定为 pnpm 11.1.2。

```sh
corepack pnpm install
corepack pnpm check
dsh plugin --profile web add "$PWD"
```

构建输出为 `dist/`。源码变更后重新构建并重启 Host；本机使用 `systemctl --user restart dsh-web`，再执行 `dsh-url` 获取访问地址。

## 开发数据库

### PostgreSQL

```sh
corepack pnpm dev:db
corepack pnpm test:integration
corepack pnpm dev:db stop
```

脚本管理带所属标识的 `stellane-phase1-postgres` 容器和数据卷，只绑定 `127.0.0.1` 的随机端口。连接字段位于 `.stellane-dev/connection.json`，读取角色对测试表只有 SELECT 权限。

测试表 `sample_data(id, label, value, group_name)` 包含 3 条通用记录，数值为 120、80、160，用于验证参数查询、权限、继承与隔离。

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

自定义实例的状态位于 `.stellane-dev/stello-<instance>`，资源名称和所属标识为 `stellane-<instance>`。脚本核对所属标识，只管理自身资源；停止保留数据，恢复后的可用性按 Stello 实际状态核对。测试只回收自身创建且身份匹配的分支，保留基线。

## 使用 SQL 与分支

1. 在连接页登记 PostgreSQL 连接或 Stello 客户端配置、项目目录和 `database/branch` 来源。
2. 在“探索”选择“执行 SQL”，或切换到“向 Agent 提问”。SQL 的结果和历史可分别查看。
3. 需要独立修改时，固定当前来源，再从固定切面派生可写环境。
4. 在工作分支提交单条 DDL / DML，保存数据修改、持久笔记或中间结果。可从同一切面派生多个独立分支。
5. 交付结果时指定祖先接收环境、摘要和只读证据 SQL。系统固定本次状态并保存证据，之后的工作修改不改变交付内容。

已提交的持久状态随分支继承；SQL 会话、临时表、未提交事务和外部文件不继承。

| 工具 | 用途 |
| --- | --- |
| `stellane_context` | 检索相关元数据、业务说明、数据关系和视图血缘 |
| `stellane_environments` / `stellane_query` | 当前项目环境与只读查询 |
| `stellane_learn` | 核对并保存行键或相等关联，也用于重新验证历史观察 |
| `stellane_checkpoint` / `stellane_fork` | 固定状态、派生可写环境 |
| `stellane_execute` | 单条 SQL 事务与回执 |
| `stellane_deliver` / `stellane_results` | 固定结果交付与读取 |
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

普通 PG 以连接登记及实际目标作为来源依据；这不是不可替换的物理实例证明。Stello 额外核对原资源身份和来源，固定切面返回固定位置，可写分支的 forkLsn 仅表示起始来源。结构指纹与 MVCC 观测不代表数据内容版本。普通 PG 同连接环境、Stello 同来源分支可以共享结构仍匹配的定义；新连接登记默认隔离。

返回值包含上下文 ID、实际目标、观测时间、结构与目录指纹、来源定义、被排除版本及原因、元数据执行记录。上下文保存本次问题和选中的定义版本、对象 ID，便于追溯 Agent 实际获得的资料。传入同环境的 `previousContextId` 可比较结构和定义是否变化。完整历史和导入仅供用户访问，Agent 读取当前适用内容；SQL 示例不会自动执行。

元数据读取保存为 `purpose: context` 的执行证据，不占用面板的业务 SQL 查询历史。

初版上限：64 个可读对象，每对象 256 个字段、128 条约束，元数据响应 128 KiB；每文档 64 KiB / 16 条定义，每数据源保留最多 128 个定义版本（含历史），单次检索最多返回 16 个对象及 16 条定义。超限时明确失败，不把部分元数据当作完整目录。

## 探索记忆

在“探索”向 Agent 询问表的粒度、可用关联或视图来源。在“数据目录 → 关系与血缘”查看关联字段、基数、来源和验证时间。

`stellane_context` 返回可读对象间的直接视图依赖。上游列是视图引用的字段，包含连接、筛选等用途。沿多条依赖可以看到视图链路。证据来自 [PostgreSQL 依赖目录](https://www.postgresql.org/docs/14/catalog-pg-depend.html)和[视图重写规则](https://www.postgresql.org/docs/14/catalog-pg-rewrite.html)。

`stellane_learn` 接收 `environmentId` 和结构化 `claim`。`row-key` 接收 `target`。`join` 接收 `from`、`to`，按列顺序对应相等条件。每个对象指定 `schema`、`table`、`columns`。系统生成只读检查 SQL，在同一条语句中读取结构和检查结果。行键要求有数据、键非空且唯一。关联要求来源键非空、目标键非空且唯一、来源记录全部匹配。基数描述来源到目标的匹配范围，目标表可以有未被引用的行。

通过后自动保存，按项目与环境共享。证据记录实际对象、执行记录、观测时间与快照。固定切面可以读取适用观察。实时库和可写分支的观察标为 `needs-check`，沿用前调用同一条 `stellane_learn`。重新核对失败时，旧观察退出检索。对象结构、权限或资源身份变化也会排除旧观察。

首版检查无子表且未启用行级安全的普通表，支持最多 8 列的复合键和常见内建标量类型。每环境最多保存 128 个观察版本。视图目录读取最多 256 条可见依赖。目录读取和关系检查各受 5 秒只读 SQL 时限和预览大小限制。

## 身份、凭据与失败处理

普通 PG 密码引用支持 `env:VARIABLE_NAME` 和 `file:/absolute/path`。凭据文件须为仅当前用户可访问的普通文件，权限 `600`、上限 8 KiB。连接只保存引用；修改配置生成新连接身份。

Stello 使用 `stello context export` 导出的 HTTPS 入口、CA 和令牌文件引用，相对路径按配置文件目录解析。管理凭据与 SQL 凭据由 Host 使用，HTTPS 和 SQL 均验证服务器证书。SQLite 不保存凭据正文。

Agent 身份、调用 ID 和项目目录来自 Harness 执行上下文；Core 检查项目归属与读写权限，数据库角色继续限制 SQL。管理界面仅限 Host 所有者。来源和固定切面只读，写入限本插件派生的可写分支。

每次连接核对 Stello 服务、槽位、代次与资源 ID。同名重建不能替代旧环境，派生记录保存原准入、创建标识、父身份与实际固定位置。

本地状态默认为 `~/.local/share/stellane/state.sqlite`，目录 `700`、文件 `600`。插件的 `stateDirectory` 可指定其他绝对路径，单个 Host 管理一套状态。

- 单条 SQL 最多 16 KiB、32 个标量参数；预览最多 200 行、128 KiB。只读查询限时 5 秒，写入事务中的语句限时 30 秒。
- 每个 Core 最多 4 个并发操作，每项目最多 16 个环境，包含待核实派生。单环境写入与固定互斥，同一数据库的派生准入串行，兄弟分支 SQL 可并行。
- 写入拒绝多语句、事务控制、SET 和 CALL；数据修改与回执在同一事务提交。`stellane_internal` 为回执保留命名空间。
- 同一调用 ID 或请求 ID 返回原记录，改变原输入会被拒绝。已确认回滚为失败，提交结果未确认则为未知。
- 重启后未完成写入与派生转为待核实，只读查询转为中断。核对只观察原回执或原资源；无证据时继续保留未知。
- Stello 派生已准入后返回忙碌时，只观察同一票据的完成状态，不发送第二次创建请求。

## 检查与验收

```sh
corepack pnpm check
corepack pnpm test:integration
corepack pnpm test:stello
```

`check` 包含 Host / Client 类型检查、Core 测试和构建。PG 集成测试覆盖真实 SQL、参数、预览限制、只读拒绝和取消。语义目录集成测试覆盖元数据与权限、自然语言关键词检索、定义更新与并发版本检查、数据变化和结构变化的区别、失效排除及重启保留。Stello 集成测试验证固定位置、分支观测和语义定义继承，以及持久状态继承、并发兄弟隔离、固定结果、嵌套派生、项目与资源身份检查、事务控制拒绝，以及重启后通过回执确认提交而不重放 SQL。

探索记忆测试覆盖视图链、复合键、多对一关系、跨 Agent 检索、失效、权限和重启保留。Stello 测试报告保存在所选 `provider.json` 同目录的 `integration-report.json`。

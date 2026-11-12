# 开发与验证

## 当前版本

支持 DeepSeek Harness Web `0.2.2-rc.1`，Core 运行在 Host 插件内。当前可用：

- 普通 PostgreSQL 连接、实时只读环境、面板查询与 Agent 工具。
- Stello 来源登记、固定切面、可写子分支、DDL / DML 事务与持久回执。
- 环境来源树、实际资源身份、执行历史，以及面向祖先环境的固定结果交付。
- 项目访问检查、同次调用去重、未知操作核对与 Host 重启后的记录恢复。

应用事件驱动、知识审核、计算释放、环境删除和完整容量测量按 PRODUCT.md 的后续阶段推进。普通 PG 直连随原库变化，分支能力由 Stello 提供。

## 构建与安装

需要 Node.js 24.9+、Corepack；包管理器固定为 pnpm 11.1.2。

```sh
corepack pnpm install
corepack pnpm check
dsh plugin --profile web add "$PWD"
```

从仓库根目录安装，构建输出为 `dist/`，以本地链接接入。源码变更后重新构建并重启 Host。本机使用 `systemctl --user restart dsh-web`，再通过 `dsh-url` 获取访问地址。

## 开发数据库

### 普通 PostgreSQL

```sh
corepack pnpm dev:db
corepack pnpm test:integration
corepack pnpm dev:db stop
```

脚本创建 `stellane-phase1-postgres` 容器和 `stellane-phase1-postgres-data` 数据卷，只绑定 `127.0.0.1` 的随机端口。连接字段和密码引用位于 `.stellane-dev/connection.json`，读取角色只有示范表的 SELECT 权限。

### Stello

需要 Linux、Docker，以及已经构建完成的 Stello PG14 安装目录。开发脚本参考 Stello 的产品部署入口，创建独立的 systemd 主机容器、RustFS 容器和内部网络。

```sh
corepack pnpm dev:stello --source /path/to/Stello
corepack pnpm test:stello
corepack pnpm dev:stello stop
```

安装目录默认为 Stello 仓库的 `build-layout/pg14-current/install`，可用 `--prefix /path/to/install` 指定。首次启动复制一份构建产物到 `.stellane-dev/stello/install`，容器只读挂载这份副本。来源与构建状态记录在 `build.json`；开发副本不等同于经过发布验收的安装包。

自有资源为 `stellane-phase2-host`、`stellane-phase2-objects` 与 `stellane-phase2` 网络，均带 `com.stellane.owner=stellane-phase2` 标识。主机使用独立 PID、挂载、网络和 cgroup 命名空间，开发上限为 4 CPU、6 GiB 内存、8 个 Compute 槽位；每槽位 512 MiB 内存和 1 GiB 磁盘。

登记字段保存在 `.stellane-dev/stello/provider.json`。两个开发库均包含 3 笔合计 360 件的虚构订单，表名为 `demo_orders`。脚本只操作所属标识匹配的资源；同名非自有资源会报错。现有 Stello 测试部署不参与验收，也不挂载其数据和运行目录。

停止命令保留容器、数据与凭据，下次启动继续使用；脚本不自动删除持久数据。集成测试只回收自身创建且身份仍匹配的分支，保留开发基线。

## 使用分支与交付

1. 在连接页登记 Stello 客户端配置文件、项目目录和 `database/branch` 来源。来源在 Stellane 中保持只读。
2. 选择来源，填写切面名称，点击“固定当前状态”。面板显示实际固定位置与资源身份。
3. 从固定切面“派生可写环境”。在工作环境提交单条 DDL / DML，保存修改、任务笔记或中间结果表。
4. 再固定工作状态，从同一切面派生多个方案。父环境之后的修改不改变该切面，兄弟分支各自修改。
5. 在可写环境展开“交付方案”，选择祖先接收环境，填写摘要和只读证据 SQL。Stellane 固定本次状态，并在固定结果上执行查询。
6. 接收环境显示已交付方案、结果预览和证据引用。继续修改工作分支不会改变交付结果；固定结果也可继续派生。

“执行查询”始终只读；“提交写入”仅在 Stellane 派生的可写分支显示。数据库中的已提交持久状态随分支继承，临时表、未提交事务和外部文件不继承。

Agent 工具：

| 工具 | 用途 |
| --- | --- |
| `stellane_environments` / `stellane_query` | 查找当前项目环境，执行只读查询 |
| `stellane_checkpoint` / `stellane_fork` | 固定状态，从固定切面派生可写环境 |
| `stellane_execute` | 单条 SQL 作为事务提交，保存回执 |
| `stellane_deliver` / `stellane_results` | 交付固定方案，读取接收环境最近 3 个结果 |
| `stellane_reconcile_write` / `stellane_reconcile_branch` | 核对原写入回执或原派生资源，不重放操作 |

## 凭据、权限与状态

普通 PG 密码引用支持 `env:VARIABLE_NAME` 和 `file:/absolute/path`。文件须为仅当前用户可访问的普通文件，权限 `600`，上限 8 KiB。连接只保存引用；修改配置生成新的连接身份，既有环境继续使用原绑定。

Stello 使用 `stello context export` 导出的客户端配置，包含 HTTPS 管理入口、CA 路径与令牌文件引用；相对引用以配置文件所在目录解析。创建分支需要 Stello 的可写管理授权。管理令牌与 SQL 凭据仅由 Host 使用，HTTPS 和 SQL 均验证服务器证书。SQLite 不保存令牌、密码或私钥正文。

Agent 身份、调用 ID 与项目目录取自 Harness 执行上下文。Core 核对项目归属和读写能力；SQL 角色权限由数据库控制。管理界面仅限 Host 所有者。普通 PG、外部来源和固定切面禁止通过写入工具修改，只有本插件派生的可写分支可以提交写入。

Stello 每次连接都核对服务、槽位、代次和资源 ID；同名重建不能接替旧环境。派生记录保存原准入正文、创建标识、父身份与实际固定位置，不把数据库名称作为持久身份。

默认本地状态为 `~/.local/share/stellane/state.sqlite`，目录权限 `700`、文件 `600`；可在插件中配置绝对路径 `stateDirectory`。单个 Host 管理这套状态。环境、主体、SQL、参数、来源、结果预览和交付记录保存在本地；面板显示最近 100 次执行。

## 限制与失败处理

- 单条 SQL 上限 16 KiB，最多 32 个标量参数；预览最多 200 行、128 KiB。只读语句限时 5 秒，写入事务中的语句限时 30 秒。
- 每个 Core 最多 4 个并发操作；每项目最多 16 个环境，包含待核实派生。单个环境的写入和状态固定互斥；同一数据库的派生准入串行，兄弟环境 SQL 可并行。
- 写入使用扩展协议拒绝多语句，限定 SELECT / WITH / CREATE / ALTER / DROP / INSERT / UPDATE / DELETE / TRUNCATE；事务控制、SET、CALL 不受支持。`stellane_internal` 是插件维护回执的保留命名空间，业务 SQL 不应修改。
- 业务修改与回执在同一事务提交。回执绑定环境、调用、输入摘要和有界结果。Harness 同一调用 ID、界面同一请求 ID 返回原记录，改变原参数会被拒绝。
- 已确认回滚标为失败；提交结果无法确认时标为未知。取消时关闭连接。重启将未完成写入和派生标为待核实，只读查询标为中断。
- 核对写入只读取原回执，找到匹配回执后确认成功；找不到时继续保留未知。核对派生只观察原身份和创建标识。两者均不自动重放。
- 交付记录引用固定分支和该分支上的证据查询。工作环境后续修改不更新交付；重新交付产生新结果。当前结果预览有上界，完整业务明细仍在对应数据库中。

## 检查与验收

```sh
corepack pnpm check
corepack pnpm test:integration
corepack pnpm test:stello
```

`check` 包含 Host / Client 类型检查、4 项 Core 测试和构建。普通 PG 的 2 项集成测试覆盖真实查询、参数、预览、只读拒绝和取消。

Stello 集成测试在新建开发部署上运行，需为完整场景保留 8 个 Compute 槽位。它经过真实管理 API 与 SQL：继承父修改和持久表、并发兄弟写入、固定结果不随工作状态变化、嵌套派生、项目与资源身份拒绝、事务逃逸拒绝，以及重启后通过原回执确认提交且不重放 SQL。报告位于 `.stellane-dev/stello/integration-report.json`。

浏览器验收覆盖来源登记、固定与派生、面板写入、真实父子 Agent 调用、工具卡片、方案交付，以及 Host 重启后的结果复查。

本机验收中，真实父代理将订单 1 调整为 130 并固定状态；子代理验证继承值后提交采购方案 200，另一分支提交调货方案 300，业务基线保持 120。采购方案由 Agent 交付，调货方案由面板交付，父环境可查看两份固定结果。

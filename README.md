# Stellane

Branchable PostgreSQL data environments for agentic applications.

Stellane 让智能应用和子代理从已有业务或父任务状态出发，在独立的 PostgreSQL 数据环境里检索、计算和修改数据，再交付结果、保留进展或回收环境。

第一版以 **DeepSeek Harness 本地插件**交付。用户在 Harness 中配置资源、提出任务，并通过内嵌面板查看应用、任务、环境和结果。Stellane Core 由 Harness Host 插件加载，管理数据环境与资源生命周期。

当前已支持普通 PG 只读访问，以及 Stello 固定切面、可写分支、父状态继承和固定结果交付。面板与 Agent 共用 Core，记录项目、调用身份、实际数据库目标和执行结果。应用事件驱动、资源回收和完整业务演示按[产品规划](PRODUCT.md)继续开发。

## 本地开发与试用

使用 Node.js 24.9+、Corepack 和 DeepSeek Harness `0.2.2-rc.1`，在仓库根目录执行：

```sh
corepack pnpm install
corepack pnpm check
corepack pnpm dev:db
corepack pnpm test:integration
dsh plugin --profile web add "$PWD"
```

重启 Harness Host，执行 `dsh-url` 打开 Web 界面。侧栏的 **Stellane** 提供环境与查询面板，Harness 设置中也有 **Stellane** 连接页。

`dev:db` 创建带本项目标识的独立 PostgreSQL 容器、数据卷和随机本地端口，打印连接字段与密码引用，配置也保存在 `.stellane-dev/connection.json`。它不使用现有 Stello 实例。开发配置、密码和构建产物不纳入 Git。

在连接页保存这些字段、测试连接，再创建环境。可以直接执行 SQL，也可点击“在对话中查询”，检查提示词后发送给 Agent。详细配置、测试与运行限制见[开发说明](DEVELOPMENT.md)。

使用分支功能时，登记 Stello 客户端配置文件、项目目录和来源分支。选择来源并“固定当前状态”，再从该切面“派生可写环境”。提交修改后可继续固定与派生；“交付方案”会保存固定结果和证据，后续工作修改不会改变交付内容。

独立 Stello 开发部署使用已构建的 PG14 安装产物：

```sh
corepack pnpm dev:stello --source /path/to/Stello
corepack pnpm test:stello
```

脚本复制构建副本、创建本项目专用部署，登记字段位于 `.stellane-dev/stello/provider.json`。现有 Stello 测试部署不参与操作。

## 完整首版目标

1. 安装插件，在设置页登记项目、数据库、分支提供方、凭据引用和资源限制。
2. 在对话中提出目标，或在面板中启动示范应用，由业务事件触发 Agent 任务。
3. 主代理调查问题并保存工作状态，子代理在需要独立修改时申请派生环境，各自尝试方案。
4. 在“任务与环境”面板查看来源关系、Agent 进度、计算状态和结果，比较方案并选择继续、保留或回收。
5. 采用方案时，由业务应用重新核对当前数据和权限，再执行实际操作。

例如：“查出供应延期影响的订单，分别尝试替代采购和跨仓调货，比较成本和交期，保留可行方案。”

## 用户会看到什么

| 入口 | 内容 |
| --- | --- |
| 设置页 | 项目、数据库连接、基线、分支能力、凭据引用和运行限制 |
| 任务与环境面板 | 应用启停、任务树与环境来源、Agent 绑定、执行进度、计算状态、结果比较、保留与回收；详情中查看证据和审核知识 |
| 对话与工具卡片 | 提出目标、解释方案，显示每次操作的实际目标、来源、执行状态和结果引用 |

## 第一版验证什么

用供应链与订单应用跑通：业务事件 → 父任务形成工作状态 → 子代理继承并独立修改 → 比较与采用方案 → 保留或回收环境。随后增加应用、事件和派生数量，测量正确性、延迟与资源消耗。

Harness 负责 Agent 执行与子代理，Stellane 负责数据环境、权限、结果和资源策略。应用事件驱动器在 Host 运行期间工作，由用户在面板中启停。Host 退出后保留记录，重启时核对未完成操作与数据库状态。

数据库可以位于本地或远端，分支能力先用 Stello 验证。普通 PostgreSQL 支持查询、计算和保存结果，安装并验证 pgvector 后可做向量检索；固定来源、独立修改和计算释放按数据库实际能力提供。

完整设计、首版范围、开发顺序与测量依据见[产品规划](PRODUCT.md)。

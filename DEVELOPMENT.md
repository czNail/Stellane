# 开发与验证

## 当前版本

第一阶段支持 Harness Web `0.2.2-rc.1`：

- 在 Harness 设置页或 Stellane 面板保存连接配置、测试连接。
- 登记绑定项目的实时、只读 PostgreSQL 环境。
- 在面板执行查询，或准备一条 Harness 对话让 Agent 查询。
- 通过 `stellane_environments` 和 `stellane_query` 访问当前 Agent 项目的环境。
- 查看实际数据库目标、结果预览、工具卡片和本地执行历史；Host 重启后记录保留。

分支派生、SQL 写入、计算释放、回收、应用事件驱动器和知识审核尚未实现。普通 PG 直连环境随原库变化。

## 构建与安装

需要 Node.js 24.9+ 与 Corepack；包管理器固定为 pnpm 11.1.2。Host 和 Client 分开进行类型检查。

```sh
corepack pnpm install
corepack pnpm check
dsh plugin --profile web add "$PWD"
```

从仓库根目录安装。构建输出位于 `dist/`；安装以本地链接接入，不发布 npm 包。源码变更后重新构建并重启 Harness Host。本机服务可用 `systemctl --user restart dsh-web` 重启，再执行 `dsh-url` 获取当前地址。

## 专用开发数据库

```sh
corepack pnpm dev:db
corepack pnpm test:integration
```

脚本创建 `stellane-phase1-postgres` 容器和 `stellane-phase1-postgres-data` 数据卷，只绑定 `127.0.0.1` 的随机端口。只操作带 `com.stellane.owner=stellane-phase1` 标识的自有资源；同名资源不属于本项目时停止操作。

连接配置位于 `.stellane-dev/connection.json`。示范表 `demo_orders` 包含 3 笔合计 360 件的虚构订单，`stellane_reader` 只有表读取权限。现有 Stello 测试实例不参与第一阶段验收。

```sh
corepack pnpm dev:db stop
```

停止命令保留容器配置和数据卷，下次运行 `dev:db` 继续使用。脚本不自动删除持久数据。

## 连接与状态

连接字段包括项目绝对目录、数据库地址、端口、库名、用户、TLS 和密码引用。密码引用支持：

- `env:VARIABLE_NAME`：从 Harness Host 的环境读取。
- `file:/absolute/path`：读取仅当前用户可访问的密码文件，权限为 `600`，上限 8 KiB。

连接配置只保存引用。建议使用只授权所需表的只读数据库角色；远程数据库可选择 TLS 并验证证书。配置保存为新的连接身份，已有环境继续绑定原连接。

默认状态目录为 `~/.local/share/stellane`，SQLite 文件为 `state.sqlite`。单个 Harness Host 管理这套状态；可在插件配置中指定绝对路径 `stateDirectory`。项目、环境、SQL、参数、调用主体与有界结果预览保存在本地，目录权限为 `700`、数据库文件为 `600`。

Agent 身份和项目目录取自 Harness 的可信执行上下文。环境 ID 用于定位，查询前另行核对项目归属。管理界面仅允许 Host 所有者访问；密码配置不作为 Agent 工具暴露。

## 查询与失败处理

- 查询在 PostgreSQL 只读事务内执行，使用扩展协议拒绝多语句；结果预览最多 200 行、128 KiB。
- SQL 上限 16 KiB，最多 32 个标量参数；SQL 执行限时 5 秒，同一 Core 最多 4 个并发查询。
- 每次调用记录独立环境与实际数据库目标，工具和面板共用 Core。
- 取消时关闭数据库连接并记录中断。Host 重启将上次未完成的只读查询标为中断，保留记录供核对，不自动重放。
- 面板显示最近 100 次执行；本地历史不随页面关闭删除。当前不提供历史清理和分支操作。

## 代码与检查

| 目录 | 职责 |
| --- | --- |
| `src/core` | 环境、项目访问检查和 SQLite 执行记录 |
| `src/providers` | PostgreSQL 连接、凭据引用和只读执行 |
| `src/host` | Harness 服务绑定、管理操作与 Agent 工具 |
| `src/client` | 设置页、环境面板与工具卡片 |
| `src/shared` | 数据结构、输入校验和 Host / Client 通信契约 |
| `scripts` | 构建和专用开发数据库 |
| `tests` | 持久化、项目隔离、并发与真实 SQL 验证 |

```sh
corepack pnpm typecheck
corepack pnpm test
corepack pnpm build
corepack pnpm test:integration
```

浏览器验收：保存连接 → 测试连接 → 创建环境 → 统计 `demo_orders` → 点击“在对话中查询”并发送 → 核对工具卡片与面板中的 Agent 记录 → 重启 Host 后复查记录。Harness 设置中的 Stellane 连接页也需能读取相同配置。

## 第一阶段验收记录

2026-11-12，本机 Harness Web `0.2.2-rc.1`：

- 类型检查、构建、4 项 Core 测试和 2 项真实 PostgreSQL 集成测试通过；打包清单不含开发配置和密码。
- 设置页、环境面板、对话入口与工具卡片可用。真实父代理与本地子代理分别在两个环境身份下查询，均返回 3 笔订单、360 件，执行记录分别为 `fb049a2f-91f3-4fd8-a23a-0f00f4058308`、`73a3a70d-7837-4b85-ac8c-76497bb333b7`。
- 两个环境共用专用开发库，验证调用身份与环境定位；分支继承与写入隔离由第二阶段验证。
- Host 重启后连接、环境和执行记录保留。

验收中，Harness 在子代理完成后的模型续答出现一次 HTTP 404（`PI_AI_ERROR`）；父子两次 Stellane 查询均已成功，面板记录完整。此现象属于尚待复核的宿主模型链路，不计作 Stellane SQL 失败。

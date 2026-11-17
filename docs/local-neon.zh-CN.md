# 用本地 Neon 体验数据库分支

**实验性，尚未完成验收：** 本地 Docker 部署还没有跑通完整的启动、真实分支、重启和清理流程。以下是开发验证步骤，不代表已验证可用。进度见[发布状态](release-status.zh-CN.md)。


[English](local-neon.md) · [多路径试验](experiments.zh-CN.md) · [开发说明](../DEVELOPMENT.md#neon)

这个开发环境在 Docker 中运行真实的开源 Neon 服务：pageserver、broker、一个 safekeeper，以及各 timeline 独立的 compute。分支使用 Neon timeline，只读 compute 使用固定 LSN；不是复制几张表来模拟分支。

仓库中的控制器是 **Stellane 本地开发控制器**，不是 Neon 官方云控制面。不需要 Neon 账号、云 API key 或付费云资源，也不是代理云项目的「Neon Local」。单节点环境用于开发和合成试验，不是高可用部署方案。

## 启动并接入

需要 Node.js 24.9+ 与当前用户可用的 Docker。安装 Stellane 后运行：

```sh
dsh plugin --profile web exec stellane-neon start
dsh plugin --profile web exec stellane-neon status
```

包安装把实例放在 `~/.local/share/stellane-neon/`，默认实例名为 `local`；绝对路径 `STELLANE_NEON_HOME` 可覆盖这个父目录。源码方式把 `dsh plugin --profile web exec stellane-neon` 换成 `corepack pnpm dev:neon`，状态默认位于 `.stellane-dev/neon-<instance>`。首次启动下载服务镜像并记录其实际 digest；不会往已安装 npm 包内写数据。

在 Stellane 选择「数据源 → 添加数据源 → Neon (Docker)」，粘贴 `start` 打印的 `provider.json` 绝对路径，并在它打印的项目目录中使用普通 DSH 对话。安装包默认文件为 `~/.local/share/stellane-neon/local/provider.json`，源码方式为 `.stellane-dev/neon-local/provider.json`，引用私有的本地控制器令牌，不要把令牌贴进聊天。这个接入入口只接受 loopback 控制器地址。

来源初始为空。合成演示需要维护者使用显式数据库客户端和 `dsh plugin --profile web exec stellane-neon url` 提供的私有 URL，加载样例 setup 与 drift SQL。加载是测试准备，单独执行，不经过 Agent 的只读来源连接。之后按[分支教程](experiments.zh-CN.md)里的问题和 A/B 预期结果验收。普通 PostgreSQL 分析无需这些步骤。

## 可重复验证

在源码目录中，专用本地提供方测试读取这个配置：

```sh
STELLANE_NEON_LOCAL_CONFIG="$PWD/.stellane-dev/neon-local/provider.json" corepack pnpm test:neon:local
```

测试先准备合成来源，再从共同基线派生 A/B，核对隔离写入、只读结果和来源未变，最后通过产品管理逐叶回收记录的资源。请使用专用测试来源。`pnpm test:neon` 验证的是模拟 API 响应，属于另一层检查。本地环境未就绪时测试失败，不会静默跳过；失败不能写成真实验收通过；保留测试打印的状态 / 报告路径以便恢复。

要执行 A/B 数据集对照，先向专用来源加载公开的 setup 和 drift 数据，再运行 `pnpm demo:branches --neon /absolute/path/provider.json --dataset telemetry` 或 `support`。这个程序直接调用 Core；普通 DSH 对话演示需要另行验收。

## 停止、恢复和收尾

```sh
dsh plugin --profile web exec stellane-neon stop
dsh plugin --profile web exec stellane-neon start
dsh plugin --profile web exec stellane-neon reconcile
```

`stop` 停止本地控制器和属于它的容器，保留凭据、来源、timeline 与 Docker 卷。`start` 恢复同一实例。`reconcile` 只继续已记录的本地控制操作，不把未知请求换成新请求。启动失败时检查 `status` 和输出实例目录下私有的 `controller.log`。

并行工作可为每个命令加 `--instance another-name`，安装包对应 `<STELLANE_NEON_HOME>/another-name`（默认父目录见上文），源码对应 `.stellane-dev/neon-another-name`。控制操作先核对资源标签与身份，不接管其他任务的状态目录；资源仍存在时不要删掉记录目录。

结束试验后可能保留结果与父 timeline。「管理与清理 → 保留的分支」会说明依赖原因，不需要时先子后父回收，永远不删除来源。没有云账单不表示不占本地磁盘。停止开发实例不等于删除其数据卷，删除 Stellane 本地证据也不等于删除提供方存储。

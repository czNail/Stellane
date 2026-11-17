# 安装、升级与清理

[English](install-and-maintain.md) · [入门](../README.zh-CN.md) · [数据与隐私](data-and-privacy.zh-CN.md)

## 安装 Stellane

需要 Node.js **24.9+**、DeepSeek Harness Web **0.2.2-rc.1 至 rc.3** 和可用的 DSH 模型连接。安装已在 Linux 实测。

在 **插件 → 添加插件** 中输入 `stellane`。也可以用命令行安装。

```sh
dsh plugin --profile web add stellane
```

也可以先下载安装包，再用本机绝对路径安装。

```sh
mkdir -p "$HOME/Temp/stellane-install"
npm pack stellane@0.1.0 --pack-destination "$HOME/Temp/stellane-install"
dsh plugin --profile web add "$HOME/Temp/stellane-install/stellane-0.1.0.tgz"
```

重启该配置的 Web Host，再打开 **Stellane → 数据源 → 添加数据源**。普通 PostgreSQL URL 即可用于分析、血缘和记忆。

需要样例库时，按[演示的开头](../examples/README.zh-CN.md#接入演示库)启动一个独立的 PostgreSQL。

## 状态存在哪里

连接、记忆和执行证据保存在 Harness Host 上，不在浏览器里。状态目录按以下顺序选择：

1. 插件配置显式指定的绝对路径 `stateDirectory`。
2. 已存在的 `~/.local/share/stellane/state.sqlite`，保证早期用户继续读到原资料。
3. 全新安装使用 DSH profile 目录下的 `stellane-state`。宿主不提供 profile 目录时，回退到上面的旧位置。

目录和凭据文件仅供 Host 用户访问（Unix 下为 `700` / `600`）。SQLite 状态格式为 **7**。同一目录只能由一个 Core 持有：`owner.sqlite` 使用操作系统支持的排他锁。第二个 Host 提示占用时，停止原 Host，或为另一个 Host 设置独立目录。**不要删除锁文件来绕过检查。** 持有进程退出或崩溃时，操作系统会释放锁。

不同 profile 可能仍选中同一份既有旧状态。需要独立运行时，为它们显式设置不同目录；复制状态库不会让其中记录的远端分支身份变成新的资源。

### 为独立 Host 指定状态目录

先停止该 Host，再编辑对应 profile 的 `cordis.patch.yml`。默认 Web profile 文件是 `~/.dsh/profiles/web/cordis.patch.yml`；设置过 `DSH_HOME` 时是 `<DSH_HOME>/profiles/web/cordis.patch.yml`。文件顶层是 YAML 数组，把以下条目合并到已有数组中；若已有 `id: stellane`，只修改它的 `config.stateDirectory`，保留模型配置和其他插件条目：

```yaml
- id: stellane
  config:
    stateDirectory: /absolute/private/path/stellane-state
```

把示例换成 Host 用户可写的私有绝对路径，每个独立 Host 使用不同目录。新目录会建立空状态，不会自动搬迁旧连接和证据。要保留已有状态，保持 Host 停止，按下方备份步骤复制完整状态目录及凭据文件，再指向复制后的目录并重启。复制不改变远端分支身份，不能把同一份状态的两份副本作为独立来源同时运行。

## 升级与恢复

1. 停止旧 Host。早期开发版没有排他占用和新格式拒绝机制，不能与 0.1 同时写同一目录。
2. 私下备份完整状态目录，包含插件创建的凭据文件；演示数据库和本地控制器的数据另行备份。
3. 在同一 profile 安装新包并重启。格式升级前会在 `backups/` 写入并检查 SQLite 一致快照，包含尚在 WAL 中的已提交数据。迁移失败保留原格式与数据。
4. 在「管理与清理」检查数据源、近期证据和保留分支，再开始新任务。

不要用旧版本直接打开已迁移目录。有格式守卫的版本会拒绝，早期开发版未必会拒绝。需要恢复时，停止 Host，保留出问题的目录，把一致备份恢复到另一个私有目录并带上匹配的凭据文件，让兼容版本使用该目录。远端资源身份保持原样；结果未知的操作先核对，再考虑创建新资源。SQLite 备份本身不包含外部凭据、DSH 聊天和提供方存储。

## 管理动作分别做什么

| 动作 | 会发生什么 | 保留什么 |
| --- | --- | --- |
| **停用访问** | 阻止 Agent 发现该来源、新查询和新分支 | 所有者查看证据、核对与收尾；不撤销 Stellane 之外的数据库角色权限 |
| **更新凭据** | 先验证新凭据，再切换；PostgreSQL 必须保留原主机、端口、数据库、用户、TLS 与通道绑定设置 | 来源身份与历史；只删除不再被引用且由插件创建的旧凭据 |
| **归档，停止复用** | 记忆或定义版本退出复用，释放活跃容量 | 归档版本和历史证据；不会自动恢复旧版本 |
| **回收此分支** | 检查依赖后删除这一项身份匹配、由插件创建的资源 | 本地证据；来源数据库永远不是可删除对象 |
| **移除本地连接** | 移除已停用的连接登记及不再使用的插件自建凭据 | 本地记忆、历史证据与来源数据库 |
| **删除本地资料与历史** | 输入准确来源名称确认后，删除该已停用来源的本地记录、记忆、定义与证据 | 备份、DSH 聊天、模型方日志和来源数据库；不等于物理介质擦除 |

三个管理页签是「访问与凭据」「保留的分支」「记忆与资料」。仍有活动任务、结果未知的操作或保留分支时，不能移除连接或删除本地历史。分支按先子后父顺序回收；共享基线仍有子分支依赖时会保留。删掉结果后，父分支可能才满足删除条件，按面板剩余原因逐项处理。

「结束实验」关闭临时工作访问，不表示所有保存结果都已删除。Neon 结果可能仍依赖已经停止 compute 的父 timeline；Docker timeline 仍占本机磁盘。需要回收时使用保留分支清单。删除响应中断后，「核对回收」沿原请求和准确资源身份继续检查，不另造删除请求。

## 卸载

先在管理页结束或核对实验，回收不需要的保留分支。需要删除本地历史时，在插件仍安装时停用来源并执行「删除本地资料与历史」。用户自行提供的 `env:` / `file:` 凭据不会被插件删除。

停止 Host，从同一 profile 移除插件：

```sh
dsh plugin --profile web remove stellane
```

再重启 Host。卸载包不会删除状态、备份、演示数据卷、DSH 聊天或提供方数据库。按各自保留需求另行处理；各处可能保存的内容见[数据与隐私](data-and-privacy.zh-CN.md)。

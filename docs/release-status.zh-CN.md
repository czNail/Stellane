# 0.1.0 发布验收

[English](release-status.md) · [首次使用记录](first-use-validation.zh-CN.md) · [安装与维护](install-and-maintain.zh-CN.md)

**0.1 支持两条路径：** 普通 PostgreSQL 连接用于只读查询、血缘和可复核的记忆；Stello 用于从共同基线试验改动、保存结果和回收分支。Neon 的普通连接 URL 可作为 PostgreSQL 数据源使用；本地和云端 Neon 的分支入口保留实验性标识，不做本版运行验收。

| 验收项 | 结果 |
| --- | --- |
| Stello 原请求恢复 | 恢复了上一轮停在 `preparing` 的真实分支。核对原创建票据、分支身份和修订号后继续；没有再次发送创建请求。结束后回收该试验及其基线，来源指纹保持一致。 |
| Stello 从同一基线比较两案 | 用独立 Stello 测试实例跑完公开遥测数据。基线 North 3/90、South 1/40、未归因 1/20；A 得到 North 4/110、South 1/40，B 得到 North 3/90、South 2/60。写 A 时 B 保持基线，写 B 后 A 的固定结果不变。两个结果与共享基线均按身份回收，来源数据指纹不变。 |
| 基础检查及真实 PostgreSQL | Node 24.9.0 / pnpm 11.1.2 冻结安装、类型检查、构建、44 项基础测试和 8 项真实 PostgreSQL 测试通过。 |
| DSH 发行包 | 最终构建的 Host 和界面已从 0.1.0 归档分别安装到 Linux 的 DSH rc.1 与 rc.3 私有配置。两版均启动成功并运行包内 `stellane-demo` 命令。分别复测 48 项界面检查，包括中英、深浅主题、320/390px 窄屏和键盘焦点；没有注入源码或 CSS。 |
| 普通聊天运行 Stello | rc.3 上由真实模型直接发起试验，把试验分支中的值从 120 改到 135，保存固定 SQL 证据并结束临时工作；来源仍为 120。结果在面板可见，随后从管理界面单独回收，证据仍保留。 |
| 安装生命周期 | rc.1 实测卸载、从 npm 装回临时版、显式装入 0.1.0 归档并重启；原数据源登记保留。 |

0.1 仍是单 Host 插件。使用 Linux 和合成数据验收；此前有独立代理首次使用记录，外部真人反馈仍可在发布后继续收集。未验收其他操作系统或 Neon 分支运行。

## 发布操作

```sh
corepack pnpm test:package
sha256sum .stellane-dev/release/stellane-harness-plugin-0.1.0.tgz
```

校验值同时写在归档旁的 `package-check.json`。确认提交的 CI 通过后，用验收过的归档做 GitHub release 附件和 npm 发布输入。当前 npm 临时版是 `0.3.0-preview.1`，按版本号排序高于 `0.1.0`：发布时先用非默认标签（如 `stable`），确认安装成功后再显式把 [npm 的 `latest` 标签](https://docs.npmjs.com/cli/v11/commands/npm-dist-tag/)指向 0.1.0；保留 `next` 临时版。临时版用户可以显式安装 `@stellane/harness-plugin@0.1.0`，不要依赖自动升级跨过更高的临时版号。发布后再将 README 的默认安装指令切到 0.1.0。

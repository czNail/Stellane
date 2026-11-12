# Stellane

Branchable PostgreSQL data environments for agentic applications and parallel subagents, with inherited state and on-demand compute.

Stellane 为智能应用和子代理管理 PostgreSQL 数据环境：从已有业务或父任务状态出发，创建独立的工作环境，在其中检索、计算和修改数据，再选择交付结果、保留进展或回收环境。

应用可以根据业务事件持续生成任务，派生子代理，并让它们继承已经完成的工作、沿不同路径探索。Stellane 要验证的是：随着应用和任务增加，系统能否管理大量数据环境，并按实际需要提供计算资源。

数据环境关联数据库状态、任务上下文、私有结果、权限和资源预算。支持分支时，可以从固定状态继续派生；支持计算释放时，可以保留数据、暂停计算，之后继续工作。

## 第一版演示什么

用一组持续运行的智能经营应用，展示下面的完整过程：

1. 应用发现供应延期、库存不足等事件，由 Agent 判断并创建处理任务。
2. 父任务查询业务表、检索合同与历史记录，保存约束和中间结果。
3. 子代理从父任务选定的状态出发，在独立环境里尝试采购、调货或分批交付；需要时继续派生。
4. 等待中的任务保留数据，释放计算；失败或取消的路径按配置回收。
5. 比较方案，通过应用的业务操作重新检查当前状态，再采用结果。
6. 增加应用、任务和派生数量，测量继承与隔离是否正确，以及容量、延迟和资源消耗。

演示覆盖应用运行时申请、继承、使用和交还数据环境的完整过程。

## 怎样接入

第一版通过 DeepSeek Harness 的原生工具、Skill 和插件面板接入。示范应用及 Agent 运行时负责生成任务、创建子代理和执行任务；Stellane 管理它们的数据环境、来源、权限、结果和知识。

核心功能独立于 Harness。后续可以通过 MCP 等方式接入其他运行时和应用。数据库分支使用独立的提供方接口，开发时先用 Stello 验证，也可以接入其他支持分支的 PostgreSQL 数据库。

普通 PostgreSQL 可用于查询、计算和保存结果；安装并验证 pgvector 后可使用向量检索。直接连接普通 PG 时，数据仍随原库变化。固定状态、分支隔离和计算释放按数据库实际能力提供。

## 研究与测试依据

- [Supporting Our AI Overlords: Redesigning Data Systems to be Agent-First，CIDR 2026](https://www.cidrdb.org/cidr2026/papers/p32-liu.pdf)：理解智能体探索、重复工作和数据状态分叉带来的系统需求。
- [BranchBench: Aligning Database Branching with Agentic Demands](https://arxiv.org/abs/2604.17180)：参考分支工作负载与测量方法。
- [BranchBench 基准代码](https://github.com/branch-bench/BranchBench2)：已在产品规划中记录参考版本，接入后分别报告支持、失败和未实现的操作。

项目目前处于产品设计阶段，尚未开始功能实现或运行上述基准。完整设计、演示流程、测试方法和开发顺序见[产品规划](PRODUCT.md)。

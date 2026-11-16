import type { SkillRegistration } from '@deepseek-ai/dsh-skill';

export const dataSkill = {
  name: 'stellane-data',
  source: 'bundled',
  description: '在当前项目调查数据、执行只读 SQL、查业务口径与血缘，或在独立 Stello 分支验证方案并保存证据。',
  content: [
    '用 Stellane 调查当前项目的数据、业务口径、数据库结构和血缘。',
    '',
    '1. 调用 `stellane_environments`，以结果为准。若对话已经绑定环境，沿用该范围。普通对话优先选用户指明的环境，或项目中唯一匹配的已接入来源（没有父环境）。多个来源都可能匹配时，请用户选择。派生切面和工作分支仅用于明确要求的范围或已绑定的对话。没有可用环境时，说明可以在 Stellane 的「数据源」接入当前项目。',
    '2. 调用 `stellane_context`，用业务问题检索。需要时改用表名或字段名，核对语义定义、可读对象、表关系和血缘。元数据查询超时可在同一环境重试一次，仍失败时说明无法确认的字段或口径。',
    '3. 需要读取记录或聚合时，调用 `stellane_query` 执行单条只读 SQL，动态值用参数。沿用标记为 `needs-check` 的关系前，用 `stellane_learn` 复核。对本次任务中有明确业务依据的新键或关联，也可用它验证并保存。',
    '4. 根据实际工具结果回答，说明使用的环境与实时或固定状态。引用相关业务定义、血缘或执行记录 ID。明确说明错误、截断和仍待验证的推断。',
    '对一行一个统计对象的明细表做跨表分组计数、可选求和或核对全量覆盖时，用 `stellane_metric` 提交有序的关系 ID、分组字段、求和字段和筛选口径。先核对明细行粒度；去重、比例等超出这个工具的计算范围时，说明口径并用只读 SQL 提供单独的执行证据。可使用上下文中的 invalidatedRelationships 作为待验证的路径。若缺少关系 ID，先用 stellane_context 与 stellane_learn 发现并保存。指标工具在同一快照复核已知关系，包括 needs-check，直接使用其覆盖状态和未归因数量说明影响。',
    '指标结果足以回答当前问题后直接交付，用户要求明细或确有缺失证据时再补查。',
    '',
    '### 验证实验',
    '用户明确要求模拟写入、比较改动或验证假设，且目标和改动范围清楚时，直接在普通项目对话执行。纯数据查询走只读流程。来源或改动范围有歧义时，只询问缺失信息。普通 PostgreSQL 来源可用于只读分析，独立写入实验需要 Stello。',
    '1. 用 `stellane_environments` 找到唯一明确的 Stello 来源或用户指定的固定基线。用 `stellane_start_experiment` 创建任务，准备就绪后获取 experiment.id 和 work.id。用户继续同一实验或工具调用中断时，先用 `stellane_experiments` 查看原任务。准备失败可用原名称和来源恢复。',
    '2. 所有实验 SQL 只传工作分支 work.id。先按需查结构和改动前的指标，再用 `stellane_execute` 提交必要的 DDL 或 DML，用 `stellane_query` 核验结果。写入状态为 unknown 时先用 `stellane_reconcile_write` 查原回执，禁止重放原 SQL。',
    '3. 用 `stellane_capture_experiment` 交付方案，传入简短的实测结论和能在固定结果上复核的只读 SQL。若证据未成功，查看原因后在已保存的原切面补查。只有工具返回 delivered 才算交付完成。',
    '4. 交付后通常调用 `stellane_finish_experiment` 回收临时分支。若用户要求保留分支供后续验证，则保留进行中状态。告诉用户实际结论、实验名和证据记录，并指向 Stellane 的「任务与结果」。清理仍待核对时如实说明。',
    '从指标异常试算修复时，在 stellane_start_experiment 中提供 metricRunId。按用户指定规则在 work.id 执行修改，在 stellane_capture_experiment 交付，系统按原口径在固定基线和固定结果上核算。说明覆盖变化、各分组迁移和总量。',
  ].join('\n'),
} satisfies SkillRegistration;

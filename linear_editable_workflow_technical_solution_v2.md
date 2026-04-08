# 线性可编辑流程控制工具技术方案

## 1. 背景与目标

当前系统需要一个可被 AI / agent 调用的流程控制工具，用于管理“按步骤推进、但运行时可编辑”的执行流程。该工具不追求通用工作流引擎能力，也不采用图状态或复杂 BPMN 模型，而是聚焦于以下能力：

- 用一个线性待办列表表达流程
- 用一个当前步骤指针表达执行位置
- 由工具显式控制步骤转移
- 支持运行时编辑未来待办步骤
- 支持渐进式暴露当前步骤的详细说明与准则
- 支持在关键节点进入“等待用户交互”状态
- 支持定义多个流程模板，agent 通过参数选择启动哪一个流程

该工具的定位是：

> 一个面向 agent 的、线性队列式、可编辑、可交互的流程状态机。

---

## 2. 设计原则

### 2.1 简化模型

不引入图结构，不维护复杂分支边。
所有灵活性都通过以下机制实现：

- 线性待办步骤队列
- 当前步骤指针
- 未来步骤插入 / 删除
- 当前步骤完成后进入下一步
- 当前步骤进入等待用户交互

### 2.2 历史不可改写

只允许编辑**当前步骤之后**的未来待办，不允许修改已经完成的历史步骤。这样可以保证：

- 流程轨迹可审计
- agent 不会篡改历史
- “回退”统一转化为“插入一个重做步骤”

### 2.3 渐进式信息暴露

启动流程时，只暴露：

- 全局待办概览
- 当前步骤的简要摘要

只有当 agent 显式进入当前步骤时，才返回该步骤的完整说明、规则与准则。

### 2.4 工具控制转移

步骤转移不能靠 agent 自己“脑补”，必须通过工具显式触发。
工具只提供 3 种步骤转移动作：

- `next`：进入下一步
- `edit`：编辑未来待办步骤
- `wait_interaction`：进入等待用户交互状态

### 2.5 不预设用户回复类型

等待交互时，系统不限制用户只能做“确认 / 拒绝 / 选择某个枚举动作”。
用户只需要回复**自然语言文本**。

随后由 agent 结合：

- 当前步骤上下文
- 当前步骤详细说明
- 用户回复文本
- 当前流程历史

来决定下一步是：

- 直接继续当前步骤并 `next`
- 先 `edit` 调整未来待办
- 再次 `wait_interaction`
- 或在当前步骤内做更多处理

也就是说，这个工具负责“暂停与恢复”，而不负责把用户输入强行结构化成固定选项。

### 2.6 V1 工程化落地策略

为降低首版复杂度，V1 在工程实现上采用以下约束：

- 每个 session 同时最多只允许 **1 个活跃 workflow 实例**
- workflow 作为一个普通 agent tool 接入，复用现有 tool call / tool result 消息体系
- workflow 模板在 V1 中先采用**代码注册表**方式维护，不先做数据库模板管理
- 前端先复用现有消息流和 composer dock 体系，不引入新的消息协议类型

这样做的目标是：

- 先把线性状态机与交互闭环跑通
- 降低数据库、OpenAPI、SDK、前端同步链路的改动范围
- 避免在 V1 同时引入“模板管理系统”与“运行态状态机”两个复杂问题

---

## 3. 非目标

本方案不解决以下问题：

- 不做通用图工作流引擎
- 不做自动条件分支推理引擎
- 不做跨实例事务编排
- 不做任意历史回滚
- 不做复杂权限系统
- 不做可视化流程设计器

这些能力未来可以在本方案之上继续扩展，但不是当前版本的目标。

---

## 4. 核心抽象

### 4.1 流程模板 `WorkflowTemplate`

流程模板定义一个可重复启动的标准流程。

```ts
type WorkflowTemplate = {
  id: string
  name: string
  version: string
  description?: string
  steps: StepTemplate[]
}
```

### 4.2 步骤模板 `StepTemplate`

步骤模板定义某一类步骤的静态结构。

```ts
type StepTemplate = {
  kind: string
  title: string
  summary: string

  detail?: {
    goal: string
    instructions: string[]
    rules: string[]
    expected_outputs?: string[]
  }

  policy: {
    can_next: string[]
    can_wait_interaction: boolean
    can_edit_future: boolean
    allowed_edit_ops: Array<"insert" | "delete">
  }
}
```

说明：

- `kind`：步骤类型标识，例如 `planning`、`deploy_code`
- `summary`：简要摘要，用于待办概览
- `detail`：进入当前步骤后才展开给 agent 的详细说明
- `policy`：该步骤内部允许哪些转移动作，以及执行约束

### 4.3 流程实例 `WorkflowInstance`

流程实例表示某次具体执行中的运行状态。

```ts
type WorkflowInstance = {
  id: string
  template_id: string
  status: "running" | "waiting_interaction" | "completed" | "cancelled"

  steps: StepInstance[]
  current_index: number

  context: Record<string, any>

  history: WorkflowEvent[]
  created_at: string
  updated_at: string
}
```

### 4.4 步骤实例 `StepInstance`

步骤实例是某个流程实例中的具体待办项。

```ts
type StepInstance = {
  id: string
  kind: string
  title: string
  summary: string

  detail?: {
    goal: string
    instructions: string[]
    rules: string[]
    expected_outputs?: string[]
  }

  policy: {
    can_next: string[]
    can_wait_interaction: boolean
    can_edit_future: boolean
    allowed_edit_ops: Array<"insert" | "delete">
  }

  status: "pending" | "active" | "done" | "waiting_interaction" | "skipped"

  result?: any
  interaction?: {
    reason?: string
    message?: string
    last_user_message?: string
  }
}
```

### 4.5 V1 模板来源

V1 中 `WorkflowTemplate` 不从数据库动态读取，而是由后端代码中的模板注册表提供。

即：

- `workflow_instances`、`workflow_events` 是运行态持久化数据
- `WorkflowTemplate` 是代码内静态注册的产品定义
- `start(template_id)` 时从注册表加载模板，再生成实例

示意：

```ts
type WorkflowRegistry = Record<string, WorkflowTemplate>
```

这样做意味着：

- 新增或修改模板需要改代码并发版
- 但模板结构有完整类型约束，首版实现成本最低
- 后续若需要，也可以平滑迁移到 YAML/JSON 文件或数据库表

---

## 5. 状态模型

### 5.1 实例状态

流程实例只维护四种顶层状态：

- `running`：正常执行中
- `waiting_interaction`：当前步骤等待用户输入
- `completed`：流程结束
- `cancelled`：流程取消

### 5.2 步骤状态

单个步骤只维护以下状态：

- `pending`：未开始
- `active`：当前步骤
- `done`：已完成
- `waiting_interaction`：当前步骤等待用户输入
- `skipped`：被显式跳过或逻辑跳过

---

## 6. 步骤转移动作

本方案只定义 3 个转移动作。

### 6.1 `next`

语义：

- 将当前步骤标记为完成
- 可附带本步骤结果
- 当前指针移动到下一个待办步骤
- 若没有下一步，则流程进入 `completed`

接口草案：

```ts
type NextAction = {
  action: "next"
  instance_id: string
  result?: any
}
```

执行前约束：

- 当前实例状态必须为 `running`
- 当前步骤必须允许 `next`
- 当前步骤的 `can_next` 条件必须满足

执行后效果：

- 当前步骤 `status = done`
- 保存 `result`
- 下一个步骤 `status = active`
- 若不存在下一个步骤，则实例 `status = completed`

---

### 6.2 `edit`

语义：

- 只编辑当前步骤之后的未来待办项
- 不允许改写历史步骤
- 支持插入和删除
- 不改变当前指针

接口草案：

```ts
type EditAction = {
  action: "edit"
  instance_id: string
  ops: EditOp[]
}

type EditOp =
  | {
      type: "insert_after_current"
      steps: StepDraft[]
    }
  | {
      type: "delete_future"
      step_ids: string[]
    }

type StepDraft = {
  kind: string
  title: string
  summary?: string
  detail?: {
    goal: string
    instructions: string[]
    rules: string[]
    expected_outputs?: string[]
  }
  policy?: {
    can_next: string[]
    can_wait_interaction: boolean
    can_edit_future: boolean
    allowed_edit_ops: Array<"insert" | "delete">
  }
}
```

执行前约束：

- 当前实例状态必须为 `running`
- 当前步骤必须允许编辑未来待办
- 每个编辑操作都必须合法
- 删除目标必须位于 `current_index` 之后

执行后效果：

- 更新未来待办队列
- 当前步骤与历史步骤不变
- 记录编辑事件到 `history`

---

### 6.3 `wait_interaction`

语义：

- 当前步骤不推进
- 当前实例进入等待用户交互状态
- 当前步骤变为 `waiting_interaction`
- 后续直到收到用户新文本，流程不能继续 `next`

接口草案：

```ts
type WaitInteractionAction = {
  action: "wait_interaction"
  instance_id: string
  reason?: string
  message?: string
}
```

执行前约束：

- 当前实例状态必须为 `running`
- 当前步骤必须允许 `wait_interaction`

执行后效果：

- 当前实例 `status = waiting_interaction`
- 当前步骤 `status = waiting_interaction`
- 保存等待原因与提示信息

---

## 7. 交互恢复机制

因为新增了 `wait_interaction`，所以需要一个恢复接口。

```ts
type ResumeInteractionAction = {
  action: "resume_interaction"
  instance_id: string
  user_message: string
}
```

### 7.1 恢复效果

- 实例状态恢复为 `running`
- 当前步骤状态恢复为 `active`
- 用户输入文本被记录到当前步骤的 `interaction.last_user_message`
- agent 随后可以决定：
  - 直接 `next`
  - 先 `edit`
  - 再次 `wait_interaction`

说明：

`resume_interaction` 不是步骤转移动作，只是对 `wait_interaction` 状态的恢复操作。
步骤转移动作仍然只有：

- `next`
- `edit`
- `wait_interaction`

---

## 8. “回退”“跳过”“分支”的表达方式

本方案不单独定义 `back`、`skip`、`jump` 等动作，它们统一通过线性队列编辑表达。

### 8.1 跳过

有两种方式：

#### 方式一：当前步骤直接完成并记录跳过原因

```json
{
  "action": "next",
  "instance_id": "wf_001",
  "result": {
    "skipped": true,
    "reason": "successful experience can be reused"
  }
}
```

#### 方式二：删除未来不需要的步骤

```json
{
  "action": "edit",
  "instance_id": "wf_001",
  "ops": [
    {
      "type": "delete_future",
      "step_ids": ["setup_env", "prepare_resources"]
    }
  ]
}
```

### 8.2 回退

不真正回拨指针，而是在当前步骤后插入重做步骤。

例如当前在 `run_experiment`，发现环境有问题：

```json
{
  "action": "edit",
  "instance_id": "wf_001",
  "ops": [
    {
      "type": "insert_after_current",
      "steps": [
        {
          "kind": "setup_env_retry",
          "title": "Reconfigure environment",
          "summary": "Retry remote environment setup after failed run."
        },
        {
          "kind": "run_experiment_retry",
          "title": "Retry experiment run",
          "summary": "Retry experiment launch after environment repair."
        }
      ]
    }
  ]
}
```

然后对当前步骤执行 `next`，流程就自然进入插入的补救步骤。

### 8.3 分支

根据当前步骤结果，决定是否编辑未来待办。

例如 `run_experiment` 的失败可能导致：

- 插入 `coding_fix -> deploy_retry -> run_retry`
- 或插入 `setup_env_retry -> run_retry`
- 或删除成功收尾步骤，插入 `report_failure`

本质仍然只是 `edit + next`。

---

## 9. 渐进式说明机制

### 9.1 启动流程时返回

只返回：

- 流程实例 id
- 全部待办步骤标题与状态
- 当前步骤的 `summary`

### 9.2 显式进入当前步骤时返回

提供一个只读接口：

```ts
type EnterAction = {
  action: "enter"
  instance_id: string
}
```

返回：

- 当前步骤 `title`
- `summary`
- `detail.goal`
- `detail.instructions`
- `detail.rules`
- `detail.expected_outputs`
- 当前步骤允许的操作

`enter` 不是步骤转移动作，只是读取当前步骤详情。

---

## 10. 工具接口设计

### 10.1 启动流程

```ts
type StartAction = {
  action: "start"
  template_id: string
  input?: Record<string, any>
}
```

返回示例：

```json
{
  "instance_id": "wf_exp_001",
  "template_id": "experiment_execution_v1",
  "status": "running",
  "current_step": {
    "index": 0,
    "kind": "gather_info",
    "title": "Gather experiment information",
    "summary": "Query experiment metadata, atom context, and prior successful experience."
  },
  "todo": [
    { "id": "s1", "kind": "gather_info", "title": "Gather experiment information", "status": "active" },
    { "id": "s2", "kind": "confirm_config", "title": "Confirm required configurations", "status": "pending" },
    { "id": "s3", "kind": "planning", "title": "Review or generate experiment plan", "status": "pending" }
  ]
}
```

### 10.2 读取当前步骤详情

```ts
type EnterAction = {
  action: "enter"
  instance_id: string
}
```

### 10.3 进入下一步

```ts
type NextAction = {
  action: "next"
  instance_id: string
  result?: any
}
```

### 10.4 编辑未来待办

```ts
type EditAction = {
  action: "edit"
  instance_id: string
  ops: EditOp[]
}
```

### 10.5 进入等待用户交互

```ts
type WaitInteractionAction = {
  action: "wait_interaction"
  instance_id: string
  reason?: string
  message?: string
}
```

### 10.6 恢复用户交互

```ts
type ResumeInteractionAction = {
  action: "resume_interaction"
  instance_id: string
  user_message: string
}
```

### 10.7 查看流程状态

```ts
type InspectAction = {
  action: "inspect"
  instance_id: string
}
```

### 10.8 工具返回结构建议

V1 中，workflow 不额外引入新的消息 part 类型，而是复用现有 tool result 渲染机制。

因此 `workflow` 工具每次执行后，除了自然语言 `output` 外，还应返回稳定的结构化 `metadata`，供前端专门渲染。

建议返回结构：

```ts
type WorkflowToolMetadata = {
  action: "start" | "enter" | "next" | "edit" | "wait_interaction" | "resume_interaction" | "inspect"

  instance: {
    id: string
    template_id: string
    title: string
    status: "running" | "waiting_interaction" | "completed" | "cancelled"
    current_index: number

    current_step?: {
      id: string
      kind: string
      title: string
      summary: string
      status: "pending" | "active" | "done" | "waiting_interaction" | "skipped"
      detail?: {
        goal: string
        instructions: string[]
        rules: string[]
        expected_outputs?: string[]
      }
      interaction?: {
        reason?: string
        message?: string
        last_user_message?: string
      }
    }

    steps: Array<{
      id: string
      kind: string
      title: string
      summary: string
      status: "pending" | "active" | "done" | "waiting_interaction" | "skipped"
    }>
  }

  diff?: {
    inserted?: Array<{
      id: string
      title: string
    }>
    deleted?: string[]
  }
}
```

说明：

- `instance` 提供当前完整快照，用于消息卡片与 dock 渲染
- `diff` 仅在 `edit` 时返回，用于展示插入 / 删除的未来步骤
- `detail` 仅在 `enter` 或需要展示当前步骤详情的动作中返回

### 10.9 与现有 tool 框架的对接方式

V1 中 `workflow` 的实现方式与现有 `todo`、`question` 等工具一致：

- 在 tool registry 中注册 `workflow`
- tool 参数由 zod schema 描述
- tool 的 `execute()` 内部调用 workflow service
- tool 返回 `title`、`output`、`metadata`

因此前端不需要等待新的 API 协议，只要识别 `tool === "workflow"` 即可进行专门渲染。

---

## 11. 数据持久化设计

本节区分 **V1 实际落地** 与 **后续可扩展设计**。

### 11.1 V1 实际落地

V1 建议只新增 2 张运行态表：

- `workflow_instances`
- `workflow_events`

不在 V1 中新增 `workflow_templates` 表。

原因：

- 模板在 V1 中先放代码注册表
- 实例与事件必须持久化，模板定义暂时不需要数据库化管理
- 这样可以减少模板 CRUD、版本发布、校验与管理面的额外复杂度

### 11.2 `workflow_instances`

```ts
id
session_id
template_id
template_version
title
status
current_index
steps_json
context_json
created_at
updated_at
```

建议说明：

- `session_id`：workflow 归属到哪个会话
- `template_id`：启动时使用的模板标识
- `template_version`：记录启动时模板版本，方便后续回放与兼容
- `title`：实例标题，可默认使用模板名称
- `steps_json`：当前实例完整步骤快照
- `context_json`：运行时上下文

### 11.3 `workflow_events`

```ts
id
session_id
template_id
instance_id
event_type
payload_json
created_at
```

说明：

- `payload_json` 中记录动作输入、动作结果摘要、当前步骤信息、编辑 diff 等
- `workflow_events` 用于记录：
  - start
  - enter
  - next
  - edit
  - wait_interaction
  - resume_interaction

若希望更容易做查询，也可以把 `steps` 单独拆表，但 V1 建议先直接内嵌在 `workflow_instances.steps_json` 中。

### 11.4 V2 可扩展的 `workflow_templates`

如果后续需要动态模板管理，可以再补充：

```ts
id
name
version
description
definition_json
created_at
updated_at
```

届时：

- `start(template_id)` 先查模板表
- 模板变成数据而不是代码
- 可进一步支持模板管理后台、版本发布、模板继承等能力

### 11.5 单 session 活跃实例约束

V1 增加如下约束：

- 同一个 `session_id` 下，同时最多只允许 1 个 `running` 或 `waiting_interaction` 的 workflow 实例
- 若当前 session 已存在活跃实例，则新的 `start` 应报错

建议错误码：

```json
{
  "ok": false,
  "error": {
    "code": "ACTIVE_WORKFLOW_ALREADY_EXISTS",
    "message": "Current session already has an active workflow instance."
  }
}
```

---

## 12. 运行时上下文 `context`

流程实例需要一个上下文字典，供步骤规则判断与下一步编辑使用。

例如 experiment 流程中的上下文：

```ts
type ExperimentContext = {
  exp_id?: string
  atom_id?: string
  code_path?: string
  exp_plan_path?: string
  remote_server_config?: any
  resource_root?: string
  local_resource_root?: string
  wandb_project?: string
  wandb_api_key?: string

  successful_experience?: {
    server?: any
    env_name?: string
    resource_paths?: Record<string, string>
  }

  code_changed?: boolean
  resolved_resources?: Record<string, string>
  run_attempt_count?: number
}
```

---

## 13. 步骤内部约束

每个步骤必须定义自己的转移约束。

### 13.1 `can_next`

`can_next` 是一组条件表达式，全部满足后当前步骤才允许 `next`。

例如：

```ts
{
  can_next: ["exp_id != null", "code_path != null"]
}
```

或者：

```ts
{
  can_next: ["plan_exists == true || plan_generated == true"]
}
```

实现上，V1 可以不做通用表达式引擎，而是采用以下两种方式之一：

#### 方案 A：字符串条件 + 内置解释器

适合后续更通用的扩展。

#### 方案 B：固定字段检查 + 业务代码判断

适合 V1 快速落地。
建议 V1 优先采用这一方案。

### 13.2 `can_wait_interaction`

是否允许当前步骤进入等待用户交互。

例如：

- `plan_user_review`：允许
- `run_user_review`：允许
- `confirm_config`：允许
- `deploy_code`：通常不允许

### 13.3 `can_edit_future`

是否允许当前步骤编辑未来待办。

例如：

- `run_experiment`：允许，因为失败后需要插入补救步骤
- `prepare_resources`：允许，因为可能动态展开资源相关步骤
- `register_watch`：一般不需要允许

---

## 14. 与当前 Experiment Agent 的映射

下面给出一个可以承载当前 experiment execution agent 的线性流程模板示例。

### 14.1 初始模板

```yaml
template_id: experiment_execution_v1
name: Experiment Execution Workflow
version: "1.0"

steps:
  - kind: gather_info
    title: Gather experiment information
    summary: Query experiment metadata, atom context, and prior successful experience.

  - kind: confirm_config
    title: Confirm required configurations
    summary: Ensure server config and W&B config are fully resolved.

  - kind: planning
    title: Review or generate experiment plan
    summary: Read the existing plan or invoke experiment_plan if needed.

  - kind: plan_user_review
    title: Review plan with user
    summary: Present the plan summary and wait for user input.

  - kind: coding
    title: Implement experiment code
    summary: Modify code under code_path according to the plan.

  - kind: run_user_review
    title: Ask user before remote execution
    summary: Present code changes and wait for user input before deployment.

  - kind: deploy_code
    title: Deploy code to remote server
    summary: Invoke experiment_deploy if code sync is required.

  - kind: setup_env
    title: Prepare remote environment
    summary: Invoke experiment_setup_env only when environment is not reusable.

  - kind: prepare_resources
    title: Prepare remote resources
    summary: Resolve dataset, model, and checkpoint resources.

  - kind: run_experiment
    title: Launch experiment
    summary: Invoke experiment_run with resolved resources and W&B arguments.

  - kind: register_watch
    title: Register W&B watch
    summary: Register polling for the launched experiment run.

  - kind: record_success
    title: Record successful runtime setup
    summary: Write the actual runtime environment and resource paths.

  - kind: commit_changes
    title: Commit code changes
    summary: Commit code changes if any file was modified.
```

---

### 14.2 典型执行流程示例

#### 场景一：计划已存在，环境可复用，资源可复用，直接运行成功

执行轨迹：

1. `gather_info`
2. `confirm_config`
3. `planning`
   - 直接 `next(result={ plan_source: "existing" })`
4. `plan_user_review`
   - `wait_interaction`
   - `resume_interaction(user_message="Looks good, proceed.")`
   - `next`
5. `coding`
6. `run_user_review`
   - `wait_interaction`
   - `resume_interaction(user_message="Okay, run it.")`
   - `next`
7. `deploy_code`
8. `setup_env`
   - `next(result={ env_reused: true })`
9. `prepare_resources`
   - `next(result={ resources_reused: true })`
10. `run_experiment`
11. `register_watch`
12. `record_success`
13. `commit_changes`

#### 场景二：运行失败，判定为环境问题

当前步骤在 `run_experiment`。
agent 先编辑未来步骤：

```json
{
  "action": "edit",
  "instance_id": "wf_exp_002",
  "ops": [
    {
      "type": "insert_after_current",
      "steps": [
        {
          "kind": "setup_env_retry",
          "title": "Reconfigure environment",
          "summary": "Retry remote environment setup after failed run."
        },
        {
          "kind": "run_experiment_retry",
          "title": "Retry experiment run",
          "summary": "Retry experiment launch after environment repair."
        }
      ]
    }
  ]
}
```

然后执行：

```json
{
  "action": "next",
  "instance_id": "wf_exp_002",
  "result": {
    "status": "failed",
    "failure_type": "env",
    "error": "ModuleNotFoundError: No module named 'timm'"
  }
}
```

队列自动变成：

- `run_experiment`
- `setup_env_retry`
- `run_experiment_retry`
- `register_watch`
- `record_success`
- `commit_changes`

这样无需图结构，也能完成“回退重做”。

#### 场景三：等待用户补充缺失配置

当前步骤在 `confirm_config`，发现缺少 `wandb_api_key`。

```json
{
  "action": "wait_interaction",
  "instance_id": "wf_exp_003",
  "reason": "missing_wandb_api_key",
  "message": "W&B API key is missing. Please send it to continue."
}
```

用户回复后恢复：

```json
{
  "action": "resume_interaction",
  "instance_id": "wf_exp_003",
  "user_message": "Here is the W&B key: ..."
}
```

随后 agent 在当前步骤中解析用户文本，更新 `context`，再决定是否 `next`。

#### 场景四：连续失败三次，转为等待用户决定

当前步骤在 `run_experiment_retry_3`，agent 先删除后续成功收尾步骤，再插入失败汇报步骤：

```json
{
  "action": "edit",
  "instance_id": "wf_exp_004",
  "ops": [
    {
      "type": "delete_future",
      "step_ids": ["register_watch", "record_success"]
    },
    {
      "type": "insert_after_current",
      "steps": [
        {
          "kind": "report_failure",
          "title": "Report repeated failure to user",
          "summary": "Summarize all retry failures and wait for user input."
        }
      ]
    }
  ]
}
```

然后：

```json
{
  "action": "next",
  "instance_id": "wf_exp_004",
  "result": {
    "status": "failed",
    "attempts": 3
  }
}
```

进入 `report_failure` 后：

```json
{
  "action": "wait_interaction",
  "instance_id": "wf_exp_004",
  "reason": "retry_limit_reached",
  "message": "The experiment failed 3 times. Please tell me whether to retry, revise, or stop."
}
```

---

## 15. 错误处理策略

### 15.1 非法 `next`

场景：

- 当前不在 `running`
- 当前步骤不允许 `next`
- `can_next` 条件未满足

返回：

```json
{
  "ok": false,
  "error": {
    "code": "NEXT_NOT_ALLOWED",
    "message": "Current step does not satisfy next conditions."
  }
}
```

### 15.2 非法 `edit`

场景：

- 当前步骤不允许编辑未来待办
- 删除目标不在未来步骤中
- 插入步骤定义不合法

返回：

```json
{
  "ok": false,
  "error": {
    "code": "EDIT_NOT_ALLOWED",
    "message": "Current step cannot edit future steps."
  }
}
```

### 15.3 非法 `wait_interaction`

场景：

- 当前步骤不允许等待交互
- 当前实例不在 `running`

返回：

```json
{
  "ok": false,
  "error": {
    "code": "WAIT_INTERACTION_NOT_ALLOWED",
    "message": "Current step cannot enter waiting_interaction state."
  }
}
```

### 15.4 非法 `resume_interaction`

场景：

- 当前实例不在 `waiting_interaction`
- 当前步骤不是 `waiting_interaction`

返回：

```json
{
  "ok": false,
  "error": {
    "code": "RESUME_INTERACTION_NOT_ALLOWED",
    "message": "Workflow is not waiting for user interaction."
  }
}
```

---

## 16. 审计与可观测性

每次动作都需要写入 `workflow_events`：

- `start`
- `enter`
- `next`
- `edit`
- `wait_interaction`
- `resume_interaction`

建议每条事件记录：

```ts
type WorkflowEvent = {
  id: string
  instance_id: string
  event_type: string
  payload: Record<string, any>
  created_at: string
}
```

这样可以回放整条轨迹，便于：

- 调试 agent 行为
- 复盘流程演化
- 统计常见失败点
- 审核流程编辑记录

---

## 17. 与现有系统的集成方案

本节描述该方案在当前仓库中的推荐落地方式。

### 17.1 总体实现架构

V1 推荐架构如下：

1. `workflow` 作为一个新 tool 接入 agent 工具体系
2. tool 内部调用独立的 workflow service 处理状态机逻辑
3. workflow 实例与事件持久化到数据库
4. tool 返回结构化 `metadata` 给前端消息卡片渲染
5. 前端从 session 消息流中提取最新 workflow 状态，渲染 workflow 卡片与 workflow dock

即：

- 状态机逻辑在后端 service
- 交互入口在 tool
- 展示入口在消息卡片和 composer 上方的 dock

### 17.2 为什么 V1 不单独新增 workflow API

V1 暂不建议为了 workflow 单独建设一套 REST API + OpenAPI + SDK 同步链路，原因是：

- 当前消息流已经天然承载 tool 调用结果
- `workflow` tool 返回的 `metadata` 已足够前端渲染当前状态
- 若增加新的后端 route，还需要额外修改 OpenAPI、SDK 生成、global sync、前端 bootstrap

因此 V1 的推荐策略是：

- workflow 状态持久化到数据库，保证可恢复与可审计
- 前端展示优先基于消息流中的 tool result
- 未来若需要跨 session 工作流总览，再新增专门 API

### 17.3 等待交互状态与 agent 恢复机制

`wait_interaction` 成功后，workflow 实例会停在 `waiting_interaction`。

为避免 agent 在用户下一条消息到来后忘记恢复 workflow，V1 需要在 session prompt 构建时增加动态提示：

- 如果当前 session 存在 `waiting_interaction` 的 workflow
- 则在模型本轮执行前附加一段系统级说明
- 明确要求 agent 先调用 `workflow.resume_interaction`

建议提示语义：

> There is a workflow in `waiting_interaction` state for this session. Before continuing execution, first call the `workflow` tool with `action = "resume_interaction"` for that instance using the latest user message.

这样可以把“等待用户输入”从纯约定变成更稳定的系统行为。

### 17.4 workflow 与 `question` 工具的边界

两者都与用户交互有关，但职责不同：

- `question`：适合结构化选项式提问
- `workflow.wait_interaction`：适合自然语言开放式回复

因此：

- `question` 仍用于多选 / 单选 / 明确枚举问题
- workflow 只负责流程暂停、恢复与当前步骤上下文记录
- 前端上两者也应采用不同交互样式

---

## 18. 详细代码实现计划

以下计划基于当前仓库结构给出，目标是尽量复用现有机制，减少协议面与基础设施面改动。

### 18.1 后端改动清单

#### 18.1.1 新增 workflow service

建议新增目录：

- `packages/opencode/src/workflow/`

建议文件：

- `packages/opencode/src/workflow/index.ts`
- `packages/opencode/src/workflow/template.ts`
- `packages/opencode/src/workflow/workflow.sql.ts`

职责建议：

- `index.ts`
  - 定义 `WorkflowTemplate`、`StepTemplate`、`WorkflowInstance`、`WorkflowEvent` 的 zod schema / TypeScript 类型
  - 实现 `start`、`enter`、`next`、`edit`、`wait_interaction`、`resume_interaction`、`inspect`
  - 负责实例读取、状态迁移、约束校验、事件写入
- `template.ts`
  - 提供模板注册表
  - 内置 `experiment_execution_v1` 等模板
  - 暴露 `get(templateID)`、`list()` 等读取能力
- `workflow.sql.ts`
  - 定义 `workflow_instances`、`workflow_events` 的 drizzle schema

#### 18.1.2 注册新工具

需要修改：

- `packages/opencode/src/tool/registry.ts`

新增：

- `packages/opencode/src/tool/workflow.ts`

职责建议：

- 在 `workflow.ts` 中定义 zod 参数 schema
- 将 `action` 设计为联合类型
- `execute()` 中调用 `Workflow` service
- 返回 `title`、`output`、`metadata`

#### 18.1.3 数据库 schema 接入

除新增 `packages/opencode/src/workflow/workflow.sql.ts` 外，还需要将其纳入现有 schema 聚合范围。

具体文件取决于当前 drizzle schema 组织方式，至少需要检查并修改：

- `packages/opencode/src/storage/schema.sql.ts`

如果项目当前通过集中导出汇总 schema，则需要把 workflow 表导入到该聚合出口。

#### 18.1.4 在 session prompt 中注入恢复提示

需要修改：

- `packages/opencode/src/session/prompt.ts`

计划改动：

- 在构造模型输入前，检查当前 session 是否存在 `waiting_interaction` 的 workflow
- 若存在，则拼接一段恢复提示到 prompt
- 明确要求 agent 在消费用户最新文本前优先执行 `resume_interaction`

#### 18.1.5 运行期校验与错误定义

建议在 workflow service 中统一定义错误码，至少包含：

- `ACTIVE_WORKFLOW_ALREADY_EXISTS`
- `TEMPLATE_NOT_FOUND`
- `INSTANCE_NOT_FOUND`
- `INVALID_WORKFLOW_STATE`
- `NEXT_NOT_ALLOWED`
- `EDIT_NOT_ALLOWED`
- `WAIT_INTERACTION_NOT_ALLOWED`
- `RESUME_INTERACTION_NOT_ALLOWED`
- `ENTER_NOT_ALLOWED`

### 18.2 前端改动清单

#### 18.2.1 在消息流中渲染 workflow 工具卡片

需要修改：

- `packages/ui/src/components/message-part.tsx`

需要补充：

- 为 `tool === "workflow"` 增加专门渲染分支
- 根据 `metadata.action` 切换不同展示样式
- 使用 `metadata.instance` 渲染流程概览、当前步骤、状态 badge、步骤列表

同时需要补充工具文案：

- `packages/ui/src/i18n/en.ts`
- `packages/ui/src/i18n/zh.ts`

后续如有多语言要求，再同步补齐其它语言文件。

#### 18.2.2 在 composer 上方渲染 workflow dock

需要新增：

- `packages/app/src/pages/session/composer/session-workflow-dock.tsx`

需要修改：

- `packages/app/src/pages/session/composer/session-composer-state.ts`
- `packages/app/src/pages/session/composer/session-composer-region.tsx`

计划改动：

- 从当前 session 的消息及 tool parts 中，提取最新的 workflow 状态快照
- 找出当前 session 最近一个仍然活跃的 workflow
- 在输入框上方渲染 workflow dock

V1 中建议**不要**为 workflow 新建 global sync store，原因是：

- workflow 当前状态已经存在于 tool result metadata 中
- 与 `todo`、`permission`、`question` 不同，workflow 不需要额外的前端即时提交动作 API
- 这样可以减少 event bus、bootstrap、session cache 的链路改造

#### 18.2.3 文案与本地化

建议新增前端文案：

- `workflow.running`
- `workflow.waiting`
- `workflow.completed`
- `workflow.step`
- `workflow.waitingForInput`
- `workflow.futureStepsUpdated`

至少需要修改：

- `packages/app/src/i18n/en.ts`
- `packages/app/src/i18n/zh.ts`
- `packages/ui/src/i18n/en.ts`
- `packages/ui/src/i18n/zh.ts`

### 18.3 测试改动清单

建议补充以下测试：

- `packages/opencode/test/workflow/workflow.test.ts`
  - 测试状态迁移
  - 测试未来步骤插入 / 删除
  - 测试等待与恢复
  - 测试单 session 活跃实例限制
- `packages/opencode/test/tool/workflow.test.ts`
  - 测试 tool 参数校验与输出结构
- `packages/ui/src/components/message-part.workflow.test.tsx`
  - 测试 workflow tool card 的渲染
- `packages/app/src/pages/session/composer/session-workflow-dock.test.tsx`
  - 测试 dock 状态展示与 waiting 视图

### 18.4 推荐实施顺序

建议按以下顺序推进：

1. 后端 workflow schema 与 service
2. `workflow` tool 接入 registry
3. session prompt 中注入 waiting-resume 提示
4. UI 中的 workflow tool card 渲染
5. composer 上方的 workflow dock
6. 测试补齐

这样可以保证：

- 后端状态机先独立可用
- 前端展示逐层增强
- 每一步都可单独验证

---

## 19. 前端对话界面渲染方案

### 19.1 消息流中的 workflow 卡片

workflow 工具调用结果出现在普通 assistant tool message 中，前端应渲染为专门的 workflow 卡片，而不是简单文本块。

不同动作建议的渲染方式如下：

- `start`
  - 展示 workflow 名称
  - 展示当前进度 `1 / N`
  - 展示线性步骤概览
- `enter`
  - 展示当前步骤详情
  - 包括 `goal`、`instructions`、`rules`
- `next`
  - 高亮刚完成的步骤
  - 展示下一步已切换到哪个步骤
- `edit`
  - 展示未来待办变更 diff
  - 明确显示插入了哪些步骤、删除了哪些步骤
- `wait_interaction`
  - 展示等待状态 badge
  - 展示等待原因与提示消息
- `resume_interaction`
  - 展示已恢复状态
  - 可摘要展示用户上一条自然语言输入
- `inspect`
  - 展示当前完整 workflow 快照

### 19.2 composer 上方的 workflow dock

workflow dock 的职责不是替代消息卡片，而是持续告诉用户：

- 当前 session 是否正处于某个 workflow 中
- 当前执行到哪一步
- 是否正在等待用户输入

建议信息结构：

- 第一行：workflow 名称 + 状态 badge + 当前进度
- 第二行：当前步骤标题与 summary
- 下方：线性步骤列表
- 若为 `waiting_interaction`：额外展示等待原因和提示消息

状态视觉建议：

- `done`：灰掉并带完成标记
- `active`：高亮显示
- `waiting_interaction`：强调色显示，并带 `Waiting for input`
- `pending`：普通弱态显示

### 19.3 与现有 `question` / `permission` / `todo` 的关系

推荐关系如下：

- `question` dock：阻塞式结构化问答
- `permission` dock：阻塞式权限确认
- `todo` dock：轻量进度展示
- `workflow` dock：流程态展示与等待提示

V1 中：

- workflow dock 不应阻止用户输入
- 用户仍通过普通输入框直接回复自然语言
- agent 再根据该消息执行 `resume_interaction`

### 19.4 为什么不直接复用 `todo` dock

虽然 workflow 也包含线性步骤列表，但它与 todo 有明显差异：

- workflow 有实例级状态：`running` / `waiting_interaction` / `completed`
- workflow 有当前步骤详情
- workflow 有等待用户输入的语义
- workflow 有 `edit` 产生的未来队列变化

因此 V1 可以复用现有 dock 布局与动画思路，但建议单独实现 `SessionWorkflowDock` 组件，而不是硬塞进 `SessionTodoDock`。

---

## 20. 实现建议

### 20.1 V1 范围

建议优先实现：

- `start`
- `enter`
- `next`
- `edit`
- `wait_interaction`
- `resume_interaction`
- `inspect`

并支持：

- 模板定义
- 实例持久化
- 未来步骤插入 / 删除
- 历史事件日志

并采用以下实现决策：

- 模板放代码注册表，不先做 `workflow_templates` 表
- 每个 session 最多 1 个活跃 workflow
- 不单独新增 workflow API，先复用 tool result metadata
- 前端先做 workflow tool card + workflow dock

### 20.2 V1 不做

V1 可以暂不实现：

- 通用条件表达式解释器
- 嵌套子流程实例
- 多人协同编辑
- 自动条件分支计算
- 流程图可视化
- 用户回复文本的强约束结构化协议
- 模板数据库化管理后台
- 跨 session workflow 总览页

### 20.3 V2 可扩展方向

后续可以逐步增加：

- 通用规则表达式
- 子流程实例
- 模板继承
- 步骤超时
- 并行资源子步骤
- 与 watch / monitor 工具的自动 hook 对接
- 针对用户自由文本的半结构化解析支持
- 模板 YAML/JSON 文件化
- `workflow_templates` 表与模板管理接口
- 独立 workflow API 与全局状态同步

---

## 21. 方案总结

本方案将流程控制收敛为一个非常简单但足够实用的内核：

- 一个线性待办步骤队列
- 一个当前步骤指针
- 三个步骤转移动作：
  - `next`
  - `edit`
  - `wait_interaction`

再配合一个非转移恢复动作：

- `resume_interaction`

从而实现：

- 流程线性推进
- 未来步骤动态改写
- 当前步骤渐进式说明
- 在关键节点等待用户自然语言输入
- 用插入 / 删除表达跳过、分支与重做

它尤其适合当前的 experiment execution agent 场景，因为该场景虽然灵活，但本质上仍然可以被视为：

> 一个按步骤推进、过程中不断修正未来待办的 agent 执行队列。

因此，本方案既能保持系统简单，也能承载当前复杂度下的实际运行需求。

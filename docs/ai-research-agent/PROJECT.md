# AI Research Agent - 项目规划文档

## 项目概述

**项目名称**: ai-research-agent (研究脑 / ResearchBrain)

**集成方式**: 作为 OpenCode 的功能模块进行二次开发，位于 `packages/opencode/src/research/`

**核心理念**: 将AI科研工作流解耦为**讨论阶段**与**实验验证阶段**两个独立但紧密协作的循环。

- **讨论阶段**: 将科研问题建模为"原子"网络，每个原子包含可验证的观点及其验证方案
- **实验验证阶段**: 由待验证原子驱动，AI Agent自主执行实验并归档结果

---

## 与OpenCode的关系

### 技术复用

| OpenCode 能力 | 复用方式                                              |
| ------------- | ----------------------------------------------------- |
| 文件检索      | `glob`, `grep`, `read` tools - 用于分析实验代码和结果 |
| Shell 执行    | `bash` tool - 用于远程服务器操作                      |
| Agent 系统    | `Agent` 命名空间 - 构建实验执行 Agent                 |
| Tool 注册     | `Tool.define()` - 注册科研专用工具                    |
| 数据库        | `Drizzle` + SQLite - 原子和实验数据存储               |
| 权限模型      | `PermissionNext` - 控制实验操作权限                   |
| 远程工作空间  | `Workspace` + `Adaptor` - 复用远程服务器连接          |
| MCP 集成      | 复用 MCP 协议 - 连接外部科研工具                      |

### 架构位置

```
packages/opencode/src/
├── agent/           # Agent 定义
├── tool/            # Tool 定义
├── research/        # [NEW] 科研功能模块
│   ├── atom/        # 原子系统
│   ├── paper/       # 文献管理
│   ├── code/        # 代码项目管理
│   ├── graph/       # 知识图谱
│   ├── experiment/  # 实验执行
│   ├── server/      # 远程服务器管理
│   └── storage/     # 科研数据存储
├── session/        # 会话管理
└── ...
```

---

## 核心概念定义

### 原子 (Atom)

科研知识的基本单元，结构如下：

```typescript
interface Atom {
  id: string // 全局唯一标识
  type: "observation" | "method" | "hypothesis"
  title: string // 原子标题
  content: string // 详细描述/观察记录/方法说明
  validation: Validation // 验证方案
  status: AtomStatus // 原子状态
  evidence: Evidence[] // 支持证据
  dependencies: string[] // 依赖原子ID（拓扑排序用）
  createdAt: Date
  updatedAt: Date
}

type AtomStatus = "pending" | "validating" | "validated" | "rejected" | "obsolete"

interface Validation {
  type: "mathematical" | "experimental" | "hybrid"
  protocol: string // 验证协议描述
  metrics: Metric[] // 评估指标
  experimentConfig?: ExperimentConfig
}

interface ExperimentConfig {
  environment: string // 运行环境描述
  codeTemplate: string // 实验代码模板
  expectedRuntime: number // 预期运行时间（秒）
  requiredResources: Resource[] // 资源需求
}
```

### 拓扑图 (Research Graph)

原子之间的依赖关系网络，支持：

- **前向依赖**: 验证A需要先验证B
- **反驳关系**: A的结果与B相矛盾
- **支持关系**: A的结果支持B的假设

---

## 系统架构

```
┌─────────────────────────────────────────────────────────────────┐
│                        OpenCode CLI                              │
├─────────────────────────────────────────────────────────────────┤
│  ┌─────────────────────────────────────────────────────────┐   │
│  │                    Research Module                       │   │
│  │  ┌─────────────────┐    ┌─────────────────┐            │   │
│  │  │   Discussion    │    │    Experiment   │            │   │
│  │  │    Phase        │◄──►│    Phase         │            │   │
│  │  │                 │    │                  │            │   │
│  │  │  ┌───────────┐  │    │  ┌────────────┐  │            │   │
│  │  │  │ Atom      │  │    │  │ Executor   │  │            │   │
│  │  │  │ Editor    │  │    │  │ Agent      │  │            │   │
│  │  │  └───────────┘  │    │  └────────────┘  │            │   │
│  │  │  ┌───────────┐  │    │  ┌────────────┐  │            │   │
│  │  │  │ Knowledge │  │    │  │ Remote     │  │            │   │
│  │  │  │ Graph     │  │    │  │ Server     │  │            │   │
│  │  │  └───────────┘  │    │  └────────────┘  │            │   │
│  │  └─────────────────┘    └─────────────────┘            │   │
│  └─────────────────────────────────────────────────────────┘   │
├─────────────────────────────────────────────────────────────────┤
│  OpenCode Core (复用)                                           │
│  ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐ │
│  │  Agent  │ │  Tool   │ │Storage  │ │  MCP    │ │Workspace│ │
│  └─────────┘ └─────────┘ └─────────┘ └─────────┘ └─────────┘ │
└─────────────────────────────────────────────────────────────────┘
```

### 模块设计

#### 1. 原子编辑器 (Atom Editor)

- 创建/编辑/删除原子
- 定义验证协议和实验配置
- 管理原子间的拓扑关系
- 支持LaTeX数学公式、代码块、Mermaid图表

**复用 OpenCode**:

- 使用 `read` / `write` tools 操作原子数据文件
- 使用 `grep` / `glob` 检索相关代码

#### 2. 知识图谱可视化 (Knowledge Graph)

- 基于 D3.js / React Flow 的交互式图谱
- 支持缩放、拖拽、筛选
- 状态可视化（待验证/验证中/已验证/已拒绝）
- 依赖路径高亮

#### 3. 实验执行器 (Experiment Executor Agent)

- 自动解析原子的验证协议
- 生成实验代码（Python/Shell脚本）
- 管理实验生命周期（pending → running → completed）
- 异常检测与自动重试

**复用 OpenCode**:

- 使用 `Agent` 命名空间定义实验执行 Agent
- 使用 `bash` tool 执行远程命令

#### 4. 远程服务器管理 (Remote Server Manager)

- SSH 连接池管理（复用 Workspace Adaptor）
- Docker 容器生命周期管理
- 资源配额与队列调度
- 实验环境模板（Python/Node/CUDA等）

**复用 OpenCode**:

- 复用 `workspace` 模块的远程连接能力
- 复用 `MCP` 协议连接外部工具

#### 5. 结果归档系统 (Result Archive)

- 原始输出存储
- 自动化指标提取
- 版本化对比分析
- 可复现性追踪

#### 6. 文献管理系统 (Paper Manager)

- **文献导入**
  - arXiv ID 导入（自动抓取元数据）
  - DOI 导入
  - URL 网页抓取
  - PDF 文件解析
- **文献库管理**
  - 文献元数据存储（标题、作者、年份、摘要）
  - 文献分类/标签
  - 文献搜索和筛选
- **智能分析**
  - 自动提取关键发现
  - 识别研究方法
  - 梳理假设前提
  - 找出观察结果

**复用 OpenCode**:

- 使用 `webfetch` tool 抓取网页/PDF
- 使用 `read` tool 解析本地文件
- 使用 Agent 进行文献内容分析

#### 7. 代码项目管理系统 (Code Manager)

- **代码项目目录**
  - 统一存储在 `code/` 目录下
  - 每个代码项目是**独立的 OpenCode 项目**
  - 包含完整的 OpenCode 配置 (`opencode.json`)
  - 支持任意编程语言和框架

- **作为 OpenCode 项目访问** (核心特性)
  - 每个代码目录都可以直接启动 OpenCode 会话
  - 完整复用 OpenCode 的所有能力：
    - 代码编辑和重构
    - 文件检索和搜索
    - Shell 命令执行
    - Agent 智能辅助
    - LSP 语言服务
  - 课题研究可以直接在代码目录下进行

- **代码项目管理**
  - 导入本地代码目录
  - 克隆远程 git 仓库
  - 创建新的代码项目
  - 代码版本管理（通过 git tag/commit）

- **实验关联**
  - 实验通过索引引用代码项目
  - 格式: `code/<project>@<version>`
  - 支持多代码项目对比实验

**复用 OpenCode**:

- 代码项目本质就是一个 OpenCode 项目
- 直接使用 OpenCode 的完整能力
- 无需额外开发，零成本复用

---

## 工作流设计

### Phase 1: 讨论阶段

```
用户输入 → AI分析 → 原子化 → 验证协议生成 → 拓扑构建
                              ↓
                       [原子池]
```

1. **输入**: 科研问题、假设、观察（通过 OpenCode 对话）
2. **AI分析**: LLM 理解输入内容，提取关键概念
3. **原子化**: 分解为独立原子
4. **验证协议**: 为每个原子生成验证方案
5. **拓扑构建**: 建立依赖关系

### Phase 2: 实验验证阶段

```
原子(待验证) → 实验生成 → 远程执行 → 结果回收 → 归档分析
                                                            ↓
                                                      原子状态更新
                                                            ↓
                                                      [讨论阶段反馈]
```

1. **触发**: 原子状态为 "pending" 且依赖已满足
2. **实验生成**: LLM 根据验证协议生成实验代码
3. **远程执行**: Agent 操作远程服务器运行实验
4. **结果回收**: 捕获输出、指标、日志
5. **归档分析**: 提取关键指标，更新原子状态

---

## 远程执行设计

### 复用 Workspace 架构

```
OpenCode Workspace (现有)
       │
       ├── Local Workspace
       ├── Remote Workspace (SSH)
       └── [NEW] Experiment Workspace
```

### 服务器配置

```typescript
interface ExperimentServer {
  id: string
  name: string
  type: "ssh" | "docker" | "k8s"
  endpoint: string // SSH 主机或 Docker Registry
  credentials: Credentials
  resources: {
    cpu: number // 核心数
    memory: string // 内存大小
    gpu?: GPUInfo
    maxConcurrent: number // 最大并发实验数
  }
  environment: string[] // 预装环境
}
```

### 执行流程

```
1. Agent 发送实验任务 → 服务器队列
2. 服务器分配资源 → 创建隔离环境
3. 执行实验代码 → 实时日志回传
4. 实验结束 → 收集结果 → 清理环境
5. 结果归档 → 通知 Agent
```

---

## 数据存储

### 复用 OpenCode Drizzle Schema

在 `packages/opencode/src/` 下创建 `research/` 目录：

```
src/research/
├── research.sql.ts      # 研究模块 Schema
└── storage/
    └── atoms.ts         # 原子 CRUD 操作
```

```typescript
// research.sql.ts
import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core"

export const atoms = sqliteTable("research_atoms", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull(),
  type: text("type").notNull(), // 'observation' | 'method' | 'hypothesis'
  title: text("title").notNull(),
  content: text("content").notNull(),
  validationJson: text("validation_json").notNull(),
  status: text("status").default("pending"),
  createdAt: integer("created_at", { mode: "timestamp" }),
  updatedAt: integer("updated_at", { mode: "timestamp" }),
})

export const atomRelations = sqliteTable("research_atom_relations", {
  id: text("id").primaryKey(),
  sourceAtomId: text("source_atom_id").notNull(),
  targetAtomId: text("target_atom_id").notNull(),
  relationType: text("relation_type").notNull(), // 'depends_on' | 'supports' | 'contradicts'
})

export const experiments = sqliteTable("research_experiments", {
  id: text("id").primaryKey(),
  atomId: text("atom_id").notNull(),
  serverId: text("server_id").notNull(),
  status: text("status").default("pending"),
  code: text("code").notNull(),
  output: text("output"),
  metricsJson: text("metrics_json"),
  startedAt: integer("started_at", { mode: "timestamp" }),
  completedAt: integer("completed_at", { mode: "timestamp" }),
})

export const servers = sqliteTable("research_servers", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  type: text("type").notNull(),
  endpoint: text("endpoint").notNull(),
  credentialsJson: text("credentials_json").notNull(),
  resourcesJson: text("resources_json").notNull(),
})

export const papers = sqliteTable("research_papers", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull(),
  title: text("title").notNull(),
  authorsJson: text("authors_json").notNull(),
  year: integer("year"),
  source: text("source").notNull(), // 'arxiv' | 'pdf' | 'doi' | 'manual'
  url: text("url"),
  doi: text("doi"),
  abstract: text("abstract"),
  content: text("content"),
  tagsJson: text("tags_json").notNull(),
  status: text("status").default("imported"), // 'imported' | 'processing' | 'analyzed'
  importedAt: integer("imported_at", { mode: "timestamp" }),
})

export const paperAtoms = sqliteTable("research_paper_atoms", {
  id: text("id").primaryKey(),
  paperId: text("paper_id").notNull(),
  atomId: text("atom_id").notNull(),
  extractionType: text("extraction_type").notNull(), // 'finding' | 'method' | 'hypothesis' | 'observation'
})

export const codeProjects = sqliteTable("research_code_projects", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull(),
  name: text("name").notNull(),
  path: text("path").notNull(), // 相对于 code/ 目录的路径
  description: text("description"),
  gitRemote: text("git_remote"),
  gitBranch: text("git_branch"),
  version: text("version"), // git tag 或 commit hash
  createdAt: integer("created_at", { mode: "timestamp" }),
  updatedAt: integer("updated_at", { mode: "timestamp" }),
})
```

---

## CLI 命令设计

作为 OpenCode 的子命令实现：

```bash
# 原子管理
opencode research atom create <type> <title>    # 创建原子
opencode research atom edit <id>                # 编辑原子
opencode research atom list                    # 列出所有原子
opencode research atom show <id>               # 查看原子详情
opencode research atom delete <id>             # 删除原子

# 关系管理
opencode research relation add <source> <target> <type> # 添加关系
opencode research relation remove <id>                # 移除关系

# 实验执行
opencode research experiment run <atom-id>     # 运行实验
opencode research experiment status <id>       # 查看实验状态
opencode research experiment logs <id>         # 查看实验日志

# 服务器管理
opencode research server add <name> <endpoint> # 添加服务器
opencode research server list                   # 列出服务器
opencode research server remove <id>            # 移除服务器

# 文献管理
opencode research paper import <source>         # 导入文献 (arXiv/DOI/URL/PDF)
opencode research paper list                    # 列出文献
opencode research paper analyze <id>            # 分析文献生成原子
opencode research paper show <id>               # 查看文献详情
opencode research paper delete <id>             # 删除文献

# 代码项目管理
opencode research code add <name> <path>       # 添加代码项目 (本地路径或git URL)
opencode research code list                     # 列出代码项目
opencode research code show <id>               # 查看代码项目详情
opencode research code version <id> <version>  # 创建版本快照
opencode research code delete <id>             # 删除代码项目

# 实验执行
opencode research experiment run <atom-id>     # 运行实验
opencode research experiment status <id>       # 查看实验状态
opencode research experiment logs <id>         # 查看实验日志
opencode research experiment create <atom-id>  # 创建实验

# 图谱可视化
opencode research graph                        # 启动图谱 UI
```

---

## 实施路线图

### Phase 1: 核心框架 (4周)

1. **项目初始化**
   - 在 `packages/opencode/src/research/` 创建目录结构
   - 设计 Drizzle Schema
   - 搭建基础架构

2. **原子系统**
   - 原子数据模型
   - CRUD 接口
   - 数据库迁移

3. **拓扑关系**
   - 关系数据模型
   - 图遍历算法（依赖检查、环检测）

### Phase 2: 实验执行 (4周)

4. **远程服务器管理**
   - SSH 连接池（复用 Workspace 代码）
   - Docker 环境管理
   - 资源调度

5. **实验执行器**
   - 代码生成器（基于 LLM）
   - 任务队列
   - 日志回传

6. **结果归档**
   - 输出存储
   - 指标提取
   - 版本管理

### Phase 3: 用户界面 (3周)

7. **CLI 完善**
   - 子命令注册
   - 交互式编辑器

8. **知识图谱 UI**
   - React Flow 集成
   - 状态可视化
   - 实时更新

### Phase 4: 增强功能 (3周)

9. **高级功能**
   - 数学推导验证
   - 实验模板市场
   - 团队协作

10. **集成测试**
    - 完整工作流测试
    - 性能优化
    - 文档完善

---

## 关键实现细节

### Tool 注册示例

```typescript
// packages/opencode/src/research/tool/atom.ts
import { Tool } from "@/tool/tool"

export const ResearchAtomTool = Tool.define("research_atom", async () => {
  return {
    description: "Manage research atoms",
    parameters: z.object({
      action: z.enum(["create", "read", "update", "delete", "list"]),
      // ... other params
    }),
    async execute(params, ctx) {
      // Implementation
    },
  }
})
```

### Agent 定义示例

```typescript
// packages/opencode/src/research/agent/experiment.ts
import { Agent } from "@/agent/agent"

export const ExperimentAgent = Agent.define("experiment", {
  name: "experiment",
  description: "Executes research experiments on remote servers",
  permission: {
    // 允许执行远程命令
    bash: "allow",
    // 允许读取实验结果
    read: {
      "*": "allow",
    },
  },
  mode: "subagent",
})
```

---

## 风险与挑战

1. **实验复现性**: 远程环境差异可能导致结果不一致
2. **资源调度**: 多用户场景下的资源竞争
3. **验证自动化**: 部分验证难以完全自动化（如数学证明）
4. **权限控制**: 需要在 OpenCode 权限模型中正确配置

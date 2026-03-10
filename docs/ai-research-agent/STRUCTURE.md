# AI 科研助手 - 课题目录结构

## 项目根目录结构

```
project-root/
├── .research/                          # 科研数据目录
│   ├── config.json                    # 课题配置
│   │
│   ├── code/                          # 代码项目 (独立OpenCode项目)
│   │   ├── index.json                 # 代码项目索引
│   │   ├── baseline/                  # 代码项目A
│   │   │   ├── opencode.json          # OpenCode配置
│   │   │   ├── src/
│   │   │   ├── experiments/
│   │   │   └── configs/
│   │   └── proposed/                  # 代码项目B
│   │       ├── opencode.json
│   │       ├── src/
│   │       └── ...
│   │
│   ├── papers/                        # 文献资源
│   │   ├── index.json
│   │   └── arxiv_2007.04758.json
│   │
│   ├── atoms.json                     # 原子数据
│   ├── relations.json                 # 关系数据
│   │
│   ├── experiments/                   # 实验记录
│   │   ├── exp_001/
│   │   │   ├── config.json            # 包含code索引
│   │   │   ├── output.log
│   │   │   └── metrics.json
│   │   └── ...
│   │
│   └── servers/
│       └── servers.json
│
├── src/                               # 原有业务代码（可选）
├── tests/
└── ...
```

---

## 核心文件格式

### 1. 课题配置 (.research/config.json)

```json
{
  "id": "proj_xxx",
  "name": "Transformer效率优化",
  "description": "研究如何提升Transformer模型的效率",
  "createdAt": "2024-01-15T10:00:00Z",
  "updatedAt": "2024-01-16T15:30:00Z",
  "settings": {
    "defaultServer": "server_001",
    "autoValidation": false,
    "defaultEnvironment": "python3.10"
  }
}
```

### 2. 代码项目索引 (.research/code/index.json)

```json
{
  "projects": [
    {
      "id": "code_baseline",
      "name": "baseline",
      "path": "baseline",
      "description": "Transformer基线实现",
      "git": {
        "remote": "https://github.com/user/baseline.git",
        "branch": "main"
      },
      "version": "v1.0.0",
      "createdAt": "2024-01-15T10:00:00Z"
    },
    {
      "id": "code_proposed",
      "name": "proposed",
      "path": "proposed",
      "description": "改进的Transformer实现",
      "git": {
        "remote": "https://github.com/user/proposed.git",
        "branch": "main"
      },
      "version": "v1.0.1",
      "createdAt": "2024-01-15T10:00:00Z"
    }
  ]
}
```

### 3. 原子数据 (.research/atoms.json)

```json
{
  "atoms": [
    {
      "id": "atom_001",
      "type": "hypothesis",
      "title": "剪枝方法A比方法B更有效",
      "content": "在相同参数量下，使用剪枝方法A的模型准确率高于方法B...",
      "validation": {
        "type": "experimental",
        "protocol": "在WikiText-103数据集上对比两种剪枝方法",
        "metrics": ["accuracy", "ppl", "params"],
        "experimentConfig": {
          "environment": "python3.10+torch2.0",
          "expectedRuntime": 300
        }
      },
      "status": "validated",
      "evidence": ["exp_001"],
      "source": {
        "type": "paper",
        "paperId": "arxiv_2007.04758"
      },
      "createdAt": "2024-01-15T10:00:00Z",
      "updatedAt": "2024-01-16T15:30:00Z"
    }
  ]
}
```

### 4. 关系数据 (.research/relations.json)

```json
{
  "relations": [
    {
      "id": "rel_001",
      "source": "atom_001",
      "target": "atom_002",
      "type": "depends_on"
    },
    {
      "id": "rel_002",
      "source": "atom_003",
      "target": "atom_001",
      "type": "supports"
    },
    {
      "id": "rel_003",
      "source": "atom_004",
      "target": "atom_001",
      "type": "contradicts"
    }
  ]
}
```

### 5. 文献索引 (.research/papers/index.json)

```json
{
  "papers": [
    {
      "id": "arxiv_2007.04758",
      "title": "Efficient Transformers: A Survey",
      "authors": ["Yi Tay", "Mostafa A. H. Abdel-rahman", "et al."],
      "year": 2020,
      "source": "arxiv",
      "sourceId": "2007.04758",
      "url": "https://arxiv.org/abs/2007.04758",
      "tags": ["transformer", "efficiency", "survey"],
      "status": "analyzed",
      "atomsCount": 4,
      "importedAt": "2024-01-15T10:00:00Z"
    }
  ]
}
```

### 6. 实验配置 (.research/experiments/exp_001/config.json)

```json
{
  "id": "exp_001",
  "atomId": "atom_001",
  "title": "对比基线和改进方案的效率",
  "status": "completed",
  "result": "pass",

  "code": {
    "baseline": "code/baseline@v1.0.0",
    "proposed": "code/proposed@v1.0.0"
  },

  "scripts": {
    "main": "experiments/compare.py",
    "environment": "python3.10+torch2.0"
  },

  "metrics": {
    "accuracy_baseline": 0.887,
    "accuracy_proposed": 0.923,
    "improvement": 0.036
  },

  "startedAt": "2024-01-16T10:00:00Z",
  "completedAt": "2024-01-16T10:05:00Z"
}
```

### 7. 服务器配置 (.research/servers/servers.json)

```json
{
  "servers": [
    {
      "id": "server_001",
      "name": "gpu-server-1",
      "type": "ssh",
      "endpoint": "10.0.0.100",
      "port": 22,
      "username": "research",
      "resources": {
        "cpu": 32,
        "memory": "128GB",
        "gpu": "A100 x2"
      },
      "maxConcurrent": 3,
      "environments": ["python3.10", "python3.11", "cuda11.8"]
    }
  ]
}
```

---

## 代码项目目录结构

每个代码项目是独立的 OpenCode 项目：

```
code/baseline/
├── opencode.json           # OpenCode项目配置
├── src/                    # 源代码
│   ├── model.py
│   ├── trainer.py
│   └── utils.py
├── experiments/            # 实验脚本
│   ├── train.py
│   └── evaluate.py
├── configs/               # 配置文件
│   └── default.yaml
├── data/                  # 数据目录
├── logs/                  # 日志目录
├── requirements.txt
└── README.md
```

### OpenCode 配置 (opencode.json)

```json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "model": "claude-sonnet-4-20250514"
  },
  "permission": {
    "*": "allow"
  }
}
```

---

## 资源关系图

```
                    ┌─────────────┐
                    │   课题      │
                    │ config.json │
                    └──────┬──────┘
                           │
        ┌──────────────────┼──────────────────┐
        │                  │                  │
        ▼                  ▼                  ▼
┌───────────────┐  ┌───────────────┐  ┌───────────────┐
│     Code      │  │    Papers    │  │    Atoms     │
│   (代码项目)   │  │    (文献)    │  │    (知识)    │
│               │  │               │  │               │
│ baseline/     │  │ index.json   │  │ atoms.json   │
│ proposed/     │  │ arxiv_xxx/   │  │ relations.json│
└───────┬───────┘  └───────────────┘  └───────┬───────┘
        │                                      │
        │              ┌───────────────────────┘
        │              │
        ▼              ▼
┌───────────────────────────────────────────┐
│              Experiments                  │
│              (实验记录)                    │
│                                           │
│  exp_001: 引用 code/baseline@v1.0.0      │
│           引用 code/proposed@v1.0.0       │
│           output.log, metrics.json       │
└───────────────────────────────────────────┘
```

---

## 访问流程

### 1. 访问代码项目

```bash
# 在 OpenCode 中直接打开代码目录
cd .research/code/baseline
opencode

# 或通过 Web UI
# /project/:id/code/baseline → 点击"在OpenCode中打开"
```

### 2. 运行实验

```bash
# 触发实验验证
/research validate <atom-id>

# Agent 流程：
# 1. 读取 experiments/exp_xxx/config.json
# 2. 获取 code 索引 (如: code/baseline@v1.0.0)
# 3. 从 code/ 目录读取对应代码
# 4. 在代码目录执行实验
# 5. 保存 output.log 和 metrics.json
```

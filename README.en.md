# OpenResearch

> **OpenResearch treats research as an evolving graph of claims, evidence, and decisions — not a linear pipeline from idea to paper.**

OpenResearch is an open-source AI/ML research system for **structured, traceable, human-AI collaboration**.

Its core idea is simple:

- Research should be decomposed into **atomic scientific units**
- Each unit is represented as **`Claim + Evidence`**
- The whole project is maintained as an **evolving atom knowledge graph**
- AI operates around **claim verification**: planning experiments, writing code, running evaluations, and attaching results back to the graph
- Humans stay in control of **problem selection, judgment, and decision-making**

Instead of treating research as scattered chats, temporary scripts, and final papers, OpenResearch turns it into a **persistent, inspectable, and continuously evolving research state**.

![research_loop.png](aset/research_loop.png)

[Quick Start](./README.quick-start.md)

---

## Research Loop

OpenResearch is built around a closed research loop:

1. **A human or AI proposes a new claim**
2. **AI expands the local graph context**
3. **AI generates a verification plan**
4. **AI writes code and runs experiments**
5. **Results are attached back as structured evidence**
6. **Humans accept, reject, refine, or split claims**
7. **The graph evolves**
8. **New claims emerge from the updated graph**

This makes research a **continuous graph expansion process**, rather than a one-shot workflow.

---

## Core Abstraction: Atom Knowledge Graph

The system models research as a graph of **scientific atoms**.

Each atom contains:

- **Claim** — a precise scientific statement
- **Evidence** — derivations, experiments, observations, or results supporting or challenging the claim

Atoms can take different roles, such as:

- **Fact**
- **Method**
- **Theorem**
- **Verification**

Atoms are connected by typed relations, such as:

- `motivates`
- `formalizes`
- `derives`
- `analyzes`
- `supports`
- `contradicts`
- `verifies`

This structure allows OpenResearch to represent not only final conclusions, but also the **reasoning path, intermediate decisions, failed attempts, and unresolved contradictions** behind them.

---

## Why Graph Instead of Paper

A paper is a compressed final artifact.  
It usually hides the parts that matter most during actual discovery:

- abandoned branches
- intermediate claims
- failed experiments
- fragile assumptions
- alternative explanations
- unresolved contradictions

OpenResearch is **graph-first**, not **paper-first**.

The goal is to preserve the actual research state as it evolves, so future work can build on **what was tried, what failed, what was learned, and why decisions were made**.

---

## How OpenResearch Differs from Existing AI Research Pipelines

Many AI research systems focus on **end-to-end automation**: from idea generation to experiment execution to paper writing.

OpenResearch focuses on something different:

- **atomic-level traceability**
- **inspectable reasoning state**
- **persistent research memory**
- **human-in-the-loop control**
- **fine-grained scientific collaboration**

The goal is not just to produce papers faster.  
The goal is to build a system where research remains **structured, reviewable, and reusable** over time.

---

## What OpenResearch Enables

OpenResearch is designed to support workflows such as:

- parsing papers into structured claim–evidence atoms
- building and maintaining atom knowledge graphs
- proposing and refining new claims
- generating executable verification plans
- writing and running experiment code
- collecting results as structured evidence
- attaching evidence back to the graph
- reviewing claims through accept / reject / refine / split decisions
- managing long-term research memory across iterations
- enabling collaboration between humans and AI on the level of individual claims and experiments

---

## Current Focus

OpenResearch is currently focused on AI/ML research workflows, especially those that benefit from:

- structured literature understanding
- claim-level experiment design
- experiment tracking and result aggregation
- persistent project memory
- iterative human-AI collaboration

---

## Project Status

OpenResearch is still in an early stage and under active development.

The current system already explores a full research loop:

- project initialization from papers
- atom graph construction
- experiment creation and execution
- result summarization
- evidence assessment and graph update

---

## Vision

OpenResearch is not just an “AI scientist.”  
It is a **research operating system**.

A system where:

- ideas become claims
- claims become executable validations
- results become structured evidence
- contradictions remain visible
- research stays navigable over time

The long-term goal is to make scientific work more **traceable, cumulative, and collaborative** for both humans and AI.

---

## Get Started

- [Quick Start](./README.quick-start.md)
- [Release Version](https://github.com/openResearch1/openresearch/releases/tag/v1.0)

---

## Join Us

OpenResearch may be interesting to you if you care about:

- AI-assisted scientific discovery
- human-AI research collaboration
- structured scientific memory
- interpretable research agents
- long-horizon research workflows


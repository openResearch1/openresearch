# [OpenResearch]

> **Research is not a linear pipeline. It is an evolving graph of claims, evidence, and decisions.**

OpenResearch is an open-source system for **AI-assisted AI/ML research** built around a simple idea:

**Scientific progress can be decomposed into minimal, inspectable atoms — each atom is a `claim + evidence` pair — and research can be managed as the continuous growth of an atom network.**

This project is not meant to replace researchers.

Its goal is to make **research more legible, persistent, and interactive**, so that humans and AI can collaborate at the level where real scientific work happens: not only at the paper level, but also at the level of **claims, failures, insights, and decisions**.

![research_loop.png](aset/research_loop.png)

---

## Why OpenResearch

Many research tools still frame research as a pipeline:

**idea → code → experiments → paper**

That workflow is useful, but it leaves out an important part of actual research:

**the reasoning state between those steps.**

A good research project is not just a sequence of outputs. It is a structured, evolving network that records:

- what is currently believed,
- why it is believed,
- what has been tested,
- what failed,
- what remains unresolved,
- and what might be explored next.

OpenResearch aims to make that structure explicit, so research becomes easier to inspect and revisit.

---

## Core idea: atomizing science

We model research as a graph of minimal scientific atoms.

Each atom contains:

- **Claim** — a precise scientific statement
- **Evidence** — a derivation, experiment, observation, or result supporting that statement

Atoms are connected by typed relations such as:

- `motivates`
- `formalizes`
- `derives`
- `analyzes`
- `validates`
- `contradicts`

Instead of treating a paper as one indivisible object, we treat it as a **living reasoning graph** that reflects the current state of the project.

![atom.png](aset/atom.png)

---

## What this enables

### 1. Lower hallucination risk

AI is usually more reliable when it operates on explicit, local objects rather than vague summaries of an entire research agenda.

By grounding each step in a concrete `claim + evidence` unit, the system encourages:

- local reasoning,
- explicit justification,
- and inspectable failure.

This does not guarantee correctness, but it can help reduce unsupported leaps in reasoning.

### 2. Persistent memory for long-term research

AI/ML research is often messy and long-running. Small insights are easy to lose, failed directions get repeated, and partial progress can disappear into notes or conversations.

OpenResearch tries to turn those fragments into persistent structure:

- each micro-result can be stored,
- each claim can be revised,
- each validation can be traced,
- and new ideas can be linked back to prior work.

The result is a research memory that can accumulate over time.

### 3. Fine-grained human–AI collaboration

A researcher’s value is not only execution. It also includes judgment, intuition, skepticism, and the ability to notice what matters.

OpenResearch is designed to support collaboration with AI at the granularity of:

- one claim,
- one theorem,
- one design decision,
- one failed experiment,
- one suspicious result.

That is often the level where expert input matters most.

---

## The research loop

OpenResearch is designed as an iterative loop:

1. **A human or AI proposes a new claim**
2. **AI expands the local atom context**
3. **AI generates a validation plan**
4. **AI writes code and runs experiments**
5. **Evidence and results are attached back to the atom graph**
6. **A human accepts, rejects, refines, or splits the claim**
7. **The graph grows**
8. **The next claim emerges from the updated graph**

> **Research is modeled as continuous graph expansion, not one-shot paper generation.**

---

## How this differs from existing systems

Some existing systems, such as **FARS**, emphasize end-to-end automation of the research workflow.

OpenResearch focuses on a different set of priorities.

### Systems like FARS tend to emphasize:

- end-to-end execution,
- automation,
- throughput,
- and faster idea-to-paper workflows.

### OpenResearch emphasizes:

- atomic provenance,
- inspectable reasoning state,
- persistent scientific memory,
- human-in-the-loop control,
- and fine-grained research steering.

> **A pipeline-first system treats research primarily as a workflow to execute.**  
> **OpenResearch treats research as a knowledge graph to evolutate and maintain.**

For AI/ML research, the challenge is often not only execution, but also keeping track of what has actually been learned and why.

---

## Why a graph instead of a paper-first workflow

Papers are compressed summaries of research. They often hide:

- abandoned branches,
- intermediate claims,
- failed validations,
- fragile assumptions,
- alternative explanations,
- and unresolved contradictions.

But these are often exactly the things that matter during iterative discovery.

An atom graph keeps them visible and reusable.

---

## Built for AI/ML research

AI/ML research naturally mixes:

- empirical claims,
- algorithmic constructions,
- theoretical guarantees,
- implementation details,
- and benchmark-based validation.

OpenResearch therefore separates different logical layers, such as:

- **Fact claims**
- **Method claims**
- **Theorem claims**
- **Verification claims**

This makes it easier to keep the graph clear and usable.

---

## Long-term direction

OpenResearch is not just imagined as an “AI scientist”, but as a **research operating system**:

- ideas become claims,
- claims lead to executable validation,
- results become structured evidence,
- contradictions become visible,
- and projects remain navigable over time.

The goal is not to replace researchers, but to support more effective collaboration between humans and AI.

---

## Current vision

We envision a system where humans and AI work together to turn scientific ideas into structured knowledge and experimental results. In such a system, users could:

- **analyze papers** and decompose them into claim–evidence atoms,
- **build and maintain a persistent graph** of claims and evidence,
- **propose new claims** with AI suggestions and human judgment,
- **generate validation plans** and executable code,
- **run experiments and simulations** and collect structured evidence,
- **attach results back to the graph** while preserving provenance,
- **accept, reject, refine, or split claims** as research evolves,
- **support collaboration across people and projects**, and
- **generate drafts** for papers, reports, or presentations from the graph.

The aim is to support a research workflow that remains transparent and traceable while still being useful in practice.

---

## Why open source

Because research infrastructure should also be inspectable, extensible, and shared with the community using it.

---

## Who this is for

OpenResearch is for people who care about:

- building persistent scientific state,
- reasoning locally,
- preserving uncertainty,
- making progress inspectable,
- and enabling human–AI collaboration around claims.

It is less about producing a paper as quickly as possible, and more about supporting a durable research process.

---

## Status

Early stage and still under construction.

The core thesis is simple:

> **What AI-assisted research lacks is not only better writing agents, but also a durable graph of claims, evidence, and decisions.**

---

## Join us

This project may be interesting if you care about:

- AI-assisted scientific research,
- human–AI co-discovery,
- structured scientific memory,
- interpretable research agents,
- and long-horizon research workflows.

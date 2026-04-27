---
title: Intro to the Skrun Knowledge Base Demo
---

# Intro to the Skrun Knowledge Base Demo

This is a small Markdown vault used to demonstrate the `knowledge-base-from-vault` agent. It contains five linked notes covering architecture concepts (event sourcing, cluster design), a how-to guide, and a glossary.

## What the agent does with this

The agent walks the directory, parses each note, extracts **concepts** from headings and bolded terms, and produces a navigable static site as `kb.zip`. Across runs, the agent's persistent state graph remembers concepts that recur — the more often `[[event-sourcing]]` shows up, the higher it ranks in the index.

## Suggested reading order

- [Cluster design](concepts/cluster-design.md) — start here
- [[event-sourcing]] — what it is and why we use it
- [How to run locally](how-to/run-locally.md) — practical setup
- [Glossary](glossary.md) — quick reference

## Why a static-site bundle

The output is a single `kb.zip`. You unzip it, open `index.html`, and you have a working browsable site — no server, no SaaS, no external rendering. Drop it on S3 / Netlify / GitHub Pages and you have a public docs site in two minutes.

# Event Sourcing

**Event sourcing** is a pattern where the canonical state of a domain entity is the sequence of events that happened to it, not a row in a table. The "current state" is a fold over the event log.

## Why use it

- Auditability is free — the log *is* the audit trail.
- Time travel: replay the log to any point in the past.
- Decouple write model from read models — multiple projections, optimized differently.

## Why not always use it

- Cognitive overhead: contributors used to CRUD need a ramp.
- Operational cost: replay times grow linearly with log size; you'll need snapshots eventually.
- Schema evolution: changing event shapes after-the-fact requires upcasting machinery.

## Patterns we follow

- One stream per aggregate.
- Events are immutable. Past wrongs are corrected by *new* compensating events, not by editing old ones.
- Snapshots every N events to bound replay cost.

## Related

- [[cluster-design]] — log shipping influences cluster topology
- [Glossary](../glossary.md) — event, projection, aggregate, snapshot

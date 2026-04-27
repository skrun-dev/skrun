# Glossary

Quick reference for terms used across the vault.

## Aggregate

A consistency boundary. All operations on an aggregate are atomic with respect to its [[event-sourcing|event stream]]. Cross-aggregate operations are eventually consistent.

## AZ (Availability Zone)

A failure-isolated data center within a cloud region. See [[cluster-design]] for spread strategies.

## Event

An immutable record of something that happened. Past tense (`OrderShipped`, not `ShipOrder`).

## Projection

A read-optimized view derived by folding over the event log. Multiple projections can derive from the same log.

## Quorum

The minimum number of replicas that must agree for a write to be considered durable. See [[cluster-design]] for the odd-N convention.

## Replica

One copy of a stateful service. Replicas form a quorum (or a leader-followers asymmetric set, depending on the protocol).

## Snapshot

A serialized aggregate state, taken at event N, used to bound replay time on next load. See [[event-sourcing]] for snapshotting cadence.

## Stream

The append-only log of events for an aggregate. The canonical state of an event-sourced system.

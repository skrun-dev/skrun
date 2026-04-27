# Cluster Design

The way you size and lay out the cluster shapes everything else: throughput ceilings, failure modes, cost. Get this wrong early and you'll be re-platforming for the next year.

## Three sizing axes

There are three independent dimensions to size on:

- **Compute**: how many CPU-seconds per second do you need at peak?
- **Memory**: working set + caches + headroom for GC
- **State**: durable bytes you must keep available

Treat them separately. A workload that's CPU-bound at peak but memory-bound at idle wants a different cluster than one that's the opposite.

## Quorum patterns

For consensus systems, **odd-N quorums** (3, 5, 7) tolerate `(N-1)/2` failures. We default to N=3 for most services and bump to N=5 for control-plane primitives.

Related: [[event-sourcing]] — the event log is the canonical state of a quorum-replicated stream.

## Failure domains

Spread replicas across at least 2 availability zones. Same-AZ deployments are cheaper but vulnerable to single-AZ outages — a real risk on AWS, less so on properly-multi-zone hyperscalers.

## See also

- [How to run locally](../how-to/run-locally.md) — single-node dev cluster
- [Glossary](../glossary.md) — quorum, replica, AZ

# How to Run Locally

Two-paragraph guide for booting a single-node dev cluster.

## Prerequisites

- Docker + docker-compose
- 8 GB free RAM
- Ports 4000-4010 open

## Steps

1. Clone the repo and `cd` into the root.
2. `docker compose up -d` — boots the node + dependencies.
3. `curl http://localhost:4000/health` — should return `{"status":"ok"}`.
4. To tear down: `docker compose down -v` (the `-v` removes volumes, **including** any state you produced).

## Where state lives

The local node persists state to `./data/`. To inspect:

```sh
ls -la ./data/streams/
```

You'll see one directory per [[event-sourcing|stream]] — each containing append-only segment files.

## Cluster mode

For multi-node tests, see [Cluster design](../concepts/cluster-design.md). The local-mode skips quorum logic entirely; everything runs on one process.

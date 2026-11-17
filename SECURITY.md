# Security Policy

## Reporting a Vulnerability

**Do not open a public issue.**

Report it privately through GitHub: **[Report a vulnerability](https://github.com/skrun-dev/skrun/security/advisories/new)**.
If you cannot use GitHub, email **contact@skrun.sh**.

Reports are handled on a best-effort basis: we aim to acknowledge a report within **5 business days**,
keep you informed while we work on a fix, and agree on a disclosure date with you.

## Supported Versions

Security fixes are released for the latest published version only.

## Scope

- `@skrun-dev/*` npm packages
- Agent runtime execution (sandbox, tool calling, LLM routing)
- Registry API (auth, push/pull, POST /run)

## Out of Scope

- Social engineering
- Denial of service attacks
- Issues in third-party dependencies (please report upstream)
- Vulnerabilities in LLM provider APIs

# Sample input for semgrep-rule-creator

This is a captured input you can paste into the `cve_description` and
`bad_code_example` fields of a `POST /run` call.

## CVE description

A Server-Side Request Forgery (SSRF) vulnerability exists when an HTTP
endpoint accepts a user-controlled URL and immediately fetches it from
the server side without validating that the URL points to an external,
allowed host.

An attacker can exploit this to:

- Reach the cloud metadata endpoint (`http://169.254.169.254/`) and
  exfiltrate IAM credentials.
- Probe internal services not reachable from the public internet
  (`http://localhost:6379/`, `http://internal-admin/`).
- Use the application server as an unauthenticated proxy to a
  third-party host.

The fix is to validate the URL against an allowlist of expected hosts
*before* the fetch, OR to route the request through a hardened proxy
that only forwards to known external destinations.

## Bad code example (TypeScript / Express)

```typescript
app.get("/preview", async (req, res) => {
  const url = req.query.url;
  const result = await fetch(url);
  res.send(await result.text());
});
```

## Good code example (preferred)

```typescript
const ALLOWED_HOSTS = new Set(["api.partner.com", "cdn.partner.com"]);

app.get("/preview", async (req, res) => {
  const url = req.query.url;
  if (typeof url !== "string") return res.status(400).send("bad url");
  const parsed = new URL(url);
  if (!ALLOWED_HOSTS.has(parsed.hostname)) {
    return res.status(403).send("host not allowed");
  }
  const result = await fetch(url);
  res.send(await result.text());
});
```

## Suggested input for the agent

```json
{
  "input": {
    "cve_description": "<paste the 'CVE description' section above>",
    "bad_code_example": "<paste the 'Bad code example' section above>",
    "good_code_example": "<paste the 'Good code example' section above>",
    "language": "typescript",
    "rule_id_prefix": "internal"
  }
}
```

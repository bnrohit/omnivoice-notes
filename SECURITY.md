# Security Policy

## Design principles

- Local-first storage by default.
- Explicit user action is required to start recording and to submit audio for AI processing.
- API credentials stay server-side.
- The reference server does not persist uploaded audio to disk.
- Security headers restrict framing, referrers, content types, camera/geolocation permissions and script/network origins.

## Secrets

Never commit `.env`, API keys, tokens or recordings. `.env` and `recordings/` are ignored by Git.

If a key is accidentally committed, revoke/rotate it immediately; deleting the file in a later commit is not sufficient because Git history retains it.

## Production hardening

Before public or organizational deployment, add:

- authenticated accounts and authorization;
- HTTPS-only ingress and HSTS at the reverse proxy;
- managed rate limiting / abuse protection;
- encrypted object storage instead of large JSON uploads;
- configurable retention and deletion;
- audit logging without logging transcript/audio content;
- CSRF protections if cookie-based authentication is added;
- malware/content validation for imported files;
- limits on transcript size and processing duration;
- privacy/consent and records-retention policy appropriate to the deployment.

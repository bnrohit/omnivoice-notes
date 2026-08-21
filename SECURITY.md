# Security and privacy

## Recording safety

OmniVoice requires an explicit Start action and browser microphone permission. It displays a visible recording state and does not attempt hidden capture. Users must comply with applicable consent laws, workplace policy and participant expectations.

## Secret handling

`OPENAI_API_KEY`, diarization tokens and outbound webhook tokens belong only in server environment variables. `.env` is ignored by Git. Never embed secrets in `public/` files or commit them.

## Local data

Recordings, transcripts and analysis are stored in IndexedDB by default. Browser profile access therefore matters: use OS/device encryption and account lock controls on sensitive devices.

## Encrypted shares

v2 share links encrypt note/transcript/summary metadata in the browser with AES-GCM. The server receives ciphertext and IV only. The key is in the URL fragment and should be treated as a bearer secret. Anyone possessing the full share URL can decrypt the content until the server-side payload expires.

Audio is not included in encrypted share payloads in this beta.

## Server controls in the reference implementation

- request-size limits
- per-IP in-memory rate limiting
- security headers and restrictive CSP
- no arbitrary browser-controlled webhook destination
- random share IDs and expiry
- no server-side audio persistence in transcription endpoints

## Production gaps

Before offering this as a multi-tenant SaaS, add authenticated authorization on every resource, durable distributed rate limiting, database/object-store encryption, audit logs, tenant isolation, abuse controls, secret rotation, vulnerability scanning, dependency policy, backups, disaster recovery and formal retention/delete workflows.

Do not claim SOC 2, ISO 27001, HIPAA, FedRAMP, GDPR compliance, or other certification solely because technical controls exist; those require organizational, contractual and audit work beyond source code.

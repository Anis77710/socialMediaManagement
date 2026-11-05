# Auth assumptions and decisions

This document records the decisions made while implementing the customer and staff auth
modules, plus the open questions that need a product/ops answer before launch.

## Phone numbers

- Only Nepali mobile numbers are accepted: `^(96|97|98)\d{8}$`. Input may include spaces, dashes,
  `+977`, `00977` or the bare national number; it is stored only as `+977XXXXXXXXXX`.
- `ALLOWED_COUNTRY_CODES` supports additional country codes, but the national-number pattern is
  Nepal-specific. Supporting other countries requires a country-specific parser/validator.
- Legacy users without a phone get a synthetic `+97798#########` number and are set to `SUSPENDED`.
  The synthetic number is not owned by the customer, so leaving the account active would let anyone
  who guesses it receive the OTP and take over the account. Support must verify ownership and
  reactivate these accounts (or run a dedicated recovery flow). The migration never stores
  plaintext OTPs or passwords.

## OTP and SMS

- OTPs are 6 digits, valid for 5 minutes (`OTP_TTL_SEC`), HMAC-SHA256 hashed with `OTP_PEPPER` and
  the challenge id, and single-use. Only the newest challenge per phone/purpose can be verified.
- Five wrong attempts consume the challenge. Resend cooldown is 45 seconds.
- SMS text is GSM-7/ASCII: `Redflie code: 123456. Valid for 5 minutes. Never share it.` When
  `ANDROID_SMS_HASH` is configured it is appended on a new line for Android autofill.
- The Sparrow integration uses the v2 form-urlencoded API
  (`POST https://api.sparrowsms.com/v2/sms/` with `token`, `from`, `to`, `text`). The secondary and
  fallback providers share that shape. Providers are wrapped by `FallbackSmsProvider`, which can
  mark retryable and low-credit failures.
- In production, when Redis is configured, non-console/fake providers are enqueued through BullMQ
  (`SMS` queue) with 5 attempts and exponential backoff. Console/fake and Redis-less environments
  send immediately.
- `SMS_DAILY_CAP` is a global UTC-day budget. Once exhausted, unknown numbers stop receiving SMS
  while existing accounts still do, and CAPTCHA becomes mandatory. Alerts fire once at 70% through
  `SMS_ALERT_WEBHOOK_URL` or the application log. This is intentional to avoid an SMS-bombing
  amplification while keeping support for existing customers.
- CAPTCHA is required after 3 OTP requests from one IP (`CAPTCHA_AFTER_IP_REQUESTS`) or when the
  daily budget is exhausted. Turnstile is the only verifier; tests inject a fake.

## Anti-enumeration and timing

- Known and unknown phones receive the same response body shape, status and SMS behaviour. Account
  linking is only revealed after a valid OTP.
- `AUTH_TIMING_FLOOR_MS` (default 250 ms) pads successful and denylisted OTP requests so the
  database lookup and budget branch cannot be distinguished by coarse timing. It is disabled in
  tests. It is not a mathematically constant-time guarantee: DB/network jitter can still leak
  timing, and the SMS provider is called asynchronously in queue mode.
- Security events record phone hashes and masked phones, never full phone numbers, OTPs or tokens.

## Tokens and sessions

- Access tokens are ES256 JWTs with `sub`, `sid`, `tv` (tokenVersion), `scp: ["app"]`, 15-minute
  default TTL, issuer `redflie`, audience `app`.
- `JWT_PRIVATE_KEY` is a base64-encoded PKCS#8 PEM EC P-256 key. `JWT_PUBLIC_KEYS` is a JSON object
  of `kid -> base64 SPKI PEM`. Multiple public keys allow rotation; `JWT_KID` chooses the signing
  key. Keep the private key in a secret manager, never in `.env.example`.
- Refresh tokens are 32 random bytes, base64url, stored only as SHA-256 hashes. Sliding expiry is
  30 days, absolute expiry 180 days, max 10 active device families (oldest evicted). Rotation
  creates a new session in the same family.
- A rotated token used within 10 seconds returns `409 AUTH_REFRESH_RACE` to tolerate client races.
  Reuse after that revokes the whole family and records `REFRESH_REUSE`.
- `logout-all` increments `tokenVersion` and revokes all sessions; `requireAuth` rejects stale `tv`
  and suspended accounts immediately. Deletion-pending accounts remain usable during the grace
  period and receive `deletionPending: true`.
- Web refresh cookie: `__Host-rf_refresh` with `HttpOnly; Secure; SameSite=Lax; Path=/`, no Domain.
  Refresh requires an allow-listed `Origin` and `X-Requested-With`. Mobile clients send
  `X-Client: mobile` and receive the refresh token in the body instead.
- Account deletion is a soft state (`DELETION_PENDING`) with no automatic purge job in this scope.
  A scheduled job must anonymize/delete after the grace period, and a phone-number tombstone strategy
  must be chosen if the number is reused before purge. Until purge, a deleted customer's phone
  remains reserved and phone changes to that number return `409 AUTH_PHONE_IN_USE`.
- `NEW_DEVICE_LOGIN`, `PHONE_CHANGED_NOTICE` and `REFRESH_REUSE_DETECTED` are emitted through the
  `onEvent` hook (no-op by default) for a notification worker. No SMS/email is sent to the old phone
  or for new-device alerts inside this module.

## Rate limits

| Scope | Limit |
| --- | --- |
| OTP resend (phone) | 1 / 45 s |
| OTP sends (phone) | 3 / 15 min |
| OTP sends (phone) | 8 / day |
| OTP sends (IP) | 20 / hour |
| OTP verify (IP) | 60 / 15 min |
| Refresh (token) | 30 / minute |

Redis uses Lua sliding-window counters with the Redis server clock. Without Redis (tests, local
single-instance), in-memory versions are used; limits are then per process and reset on restart.

## API and errors

- Auth endpoints are mounted at `/v1/app/auth` and `/v1/public/auth`. Legacy `/api/v1/*` business
  endpoints remain available and still use `Authorization: Bearer`.
- Errors use `application/problem+json` with `type`, `title`, `status`, `code`, `detail` and an
  optional `errors` object. `429` responses include `Retry-After`.
- `GET /v1/public/auth/config` exposes terms/privacy versions, OTP length/TTL and whether CAPTCHA
  is currently required. Clients should fetch it on startup.
- Swagger UI is at `/docs` when `SWAGGER_ENABLED=true`; `docs/openapi.json` is generated by
  `npm run openapi:export`.

## Testing and operations

- Unit tests cover phone normalization (including property-based tests), OTP hashing/locking,
  token signing/verification, env boot refusal, log redaction, auth service rules (rate limits,
  refresh races/reuse, Google flows, account states, phone change) and route-level auth/cookies.
- Testcontainers integration tests start Postgres 17 and Redis 7 and are skipped automatically when
  Docker is unavailable (`SKIP_TESTCONTAINERS=1` also skips them). CI runs them on Ubuntu.
- There is no background job in this module for deletion purge, security-event retention or
  denylist administration. `DenyListEntry` and the repo methods exist but no admin API is exposed.
- Redis is required outside tests: the app fails fast if `REDIS_URL` is unreachable. Unit/route
  tests deliberately use per-process memory implementations. No Docker is available on some
  developer machines; Redis and Postgres can be run via `docker compose up -d`.
- `@fastify/jwt` and `argon2` are no longer dependencies; the module uses `jose` and OTP-only auth.

## Staff authentication and administration

### Runtime split

- `RUNTIME_ROLE=app-api` (default) does not mount `/v1/admin`. `RUNTIME_ROLE=admin-api`
  (`npm run dev:admin`, port 3001 by default) mounts `/v1/admin` and keeps the customer routes
  available for impersonation. Both roles share the same code and database.
- The admin console is expected on `ADMIN_WEB_URL`. All mutations require an exact `Origin` match,
  including same-origin requests; reverse proxies must forward the browser's `Origin` unchanged.

### Bootstrap and staff lifecycle

- There is no public staff signup. The first `SUPER_ADMIN` is created with
  `npm run cli -- staff:create-superadmin <email> [name]`. The command creates an `INVITED`
  staff record and a 72-hour invite, prints the invite link, and writes an audit row with
  `actorType: SYSTEM`.
- If a super admin already exists the CLI refuses unless `--force` is passed **and**
  `CONFIRM_FORCE=yes` is set. The check counts any existing super admin, including invited ones.
- `npm run cli -- staff:reset-mfa <email>` is the break-glass path: it clears TOTP and recovery
  codes, revokes every session, alerts the staff member and super admins, and writes an audit row.
- Super admins manage staff through the API after step-up. The last active super admin cannot be
  demoted or disabled. Staff cannot change their own role or status. `INVITED` cannot be set
  through the update endpoint, and activating a staff member who never accepted an invite returns
  `409 INVITE_PENDING`.
- Disabling a staff member revokes all their sessions immediately. Every session check also
  refuses non-`ACTIVE` staff, so role/status changes take effect on the next request.
- `staff:manage` is limited to `SUPER_ADMIN` in the permission matrix, and `audit:read` /
  `audit:export` are defined but no audit API is exposed in this scope.

### Passwords

- Passwords are 12-128 characters, zxcvbn score >= 3, and must not contain the staff member's
  email/name tokens. Reuse is rejected by comparing against the current hash.
- argon2id parameters come from `ARGON2_MEMORY_KIB`, `ARGON2_TIME_COST` and
  `ARGON2_PARALLELISM`; they can be raised later and hashes are re-hashed on successful login.
- An optional `PASSWORD_PEPPER` (>= 32 chars) is HMAC-SHA256 applied before argon2. Changing the
  pepper invalidates every existing password hash; treat it as part of the key ring, not a
  routinely rotated value.
- HIBP uses the k-anonymity range API with a 2-second timeout and fails open (logs a warning and
  accepts the password). Disable with `HIBP_CHECK_ENABLED=false` in tests/offline dev.
- Passwords are never stored or logged in plaintext. Reset and invite tokens are 32 random bytes,
  stored only as SHA-256 hashes, single-use and expiring (30 minutes / 72 hours by default).

### MFA

- TOTP is RFC 6238, 6 digits, 30-second period, +/-30 seconds tolerance, issuer `TOTP_ISSUER`.
  Secrets are generated with otplib's 20-byte default and encrypted at rest with AES-256-GCM.
- The encryption envelope is `v1.<kid>.<iv>.<tag>.<ciphertext>` using base64url. `ENCRYPTION_KEYS`
  can hold a key ring; `ACTIVE_ENCRYPTION_KID` selects the write key and decryption accepts any
  configured kid. Without `ENCRYPTION_KEYS`, `TOKEN_ENCRYPTION_KEY` is used as `v1`.
- A used time step is persisted in `totpLastStep` and otplib's `afterTimeStep` prevents replay during
  sign-in. Step-up deliberately allows the current step to be reused so the same code can elevate a
  just-created session; step-up still requires the password.
- Enrollment is mandatory after accepting an invite: password login returns
  `enrollmentRequired: true` and an `enroll` token. The enrollment token is not consumed by
  `enroll/start`, only by a successful `enroll/confirm`, so a mistyped code can be retried until
  the 5-minute pre-auth token expires. MFA sign-in tokens are `mfa` purpose and are consumed only
  after a valid code, so a wrong code does not lock the user out of the token.
- Ten recovery codes are generated at enrollment, shown once, normalized to uppercase
  `XXXXX-XXXXX`, stored only as SHA-256 hashes and consumed atomically by removing the matching
  hash. Regenerating them requires step-up and replaces all existing codes.
- `ADMIN_MFA_TOKEN_TTL_SEC` (default 300) is the lifetime of both pre-auth token types.

### Sessions and CSRF

- Staff sessions are opaque 32-byte base64url tokens in `__Host-rf_admin`
  (`HttpOnly; Secure; SameSite=Strict; Path=/`, no Domain, `Max-Age` = absolute expiry).
  Only the SHA-256 hash is stored. Mobile staff clients are not in scope.
- Idle timeout 30 minutes (sliding), absolute lifetime 8 hours, max 3 active sessions (oldest
  evicted). `ADMIN_SESSION_CACHE_SEC` caches session rows for 30 seconds by token hash; revocation
  writes a tombstone (TTL at least 60 seconds) so a cached row cannot outlive a revoke.
- Every non-GET/HEAD request requires `X-CSRF-Token`; only the SHA-256 hash is stored. A user-agent
  change revokes the session. An IP change clears step-up, writes an audit row and continues the
  session; this is intentional for mobile/NAT users but should be revisited if strict binding is
  required.
- Because the cookie is `Secure`, local HTTP testing must send the cookie manually (the Postman
  collection does this). Browsers only store it over HTTPS.
- `GET` responses under `/v1/admin` carry `Cache-Control: no-store`.
- `ADMIN_IP_ALLOWLIST` is a comma-separated CIDR list (IPv4/IPv6). Empty means allow all. It is
  checked before authentication, including login, and every rejection is a 403 `IP_NOT_ALLOWED`.

### Lockout and rate limits

- Five failed password attempts lock the account for 15 minutes, doubling for each further failure
  (capped at 24 hours). Locked accounts return the same generic `AUTH_INVALID_CREDENTIALS` response.
  MFA failures also increment the same counter. An email is sent on lockout and super admins are
  alerted once `ADMIN_LOCKOUT_ALERT_THRESHOLD` (default 3) is reached.
- Login attempts are recorded with a SHA-256 email hash, IP and reason; plaintext emails and
  passwords are never stored there.
- Per-IP login limit defaults to 20 per 15 minutes. MFA verify is 20/15 min per IP, step-up is
  10/15 min per staff+IP, forgot-password is 5/15 min per IP and 3/hour per email, reset is
  20/15 min per IP, invite accept is 20/15 min per IP, and resend-style endpoints stay generic to
  avoid enumeration. Redis implementations are used when Redis is configured; tests use memory.

### Permissions and step-up

- Roles are `SUPER_ADMIN`, `OPS`, `FINANCE`, `CONTENT`, `SUPPORT`, `REVIEWER`; the matrix lives in
  `src/lib/permissions.ts`. Permission checks happen after session validation. There is no
  per-resource scoping yet; any holder of a permission can act on any target.
- Step-up elevates the current session for 10 minutes (`ADMIN_STEP_UP_MIN`) and requires the
  password plus a TOTP or recovery code. Step-up state is read fresh from the database on every
  guarded request, so a 30-second session cache cannot hide a new elevation.
- Sensitive management endpoints require both `staff:manage` and step-up; impersonation requires
  `impersonate` and step-up; recovery-code regeneration requires step-up.

### Impersonation

- A successful impersonation issues a 30-minute ES256 customer access token with `scp:
  ["app","impersonation"]`, `sid: "impersonation:<staffId>"` and an `imp` claim containing the
  staff id, email and reason. The reason is mandatory (10-500 characters).
- `requireAuth` skips customer session/revocation checks for impersonation tokens and rejects any
  method other than GET/HEAD with `403 IMPERSONATION_READ_ONLY`. The audit row, a customer
  `ADMIN_IMPERSONATION` security event and a super-admin email are written on issue. The token
  cannot refresh; obtain a new one after expiry.
- The customer is not notified in-product in this scope; the `onEvent` hook is the integration
  point for a notification worker.

### Audit log

- `AuditLog` is append-only in the application: it has no update/delete repo methods. Each row
  includes a canonical payload hash chained to the previous row
  (`sha256(prevHash + "\n" + stableStringify(payload))`), and `npm run audit:verify` validates the
  whole chain.
- Row ordering is `(at, id)`; the writer serializes appends inside one process. There is no
  cross-process advisory lock. Run a single admin-api instance, or add a database lock/queue before
  scaling writers, otherwise two processes can fork the chain.
- Database-level enforcement is a deployment step:
  `scripts/audit-log-grants.sql` revokes UPDATE/DELETE/TRUNCATE and grants INSERT/SELECT to
  `redflie_app`. Table owners bypass grants, so production must not run the API as the owner and
  the role name should be adjusted. The script is idempotent and prints a notice if the role is
  absent.
- `reason` is stored for impersonation and break-glass actions. Before/after snapshots must never
  contain passwords, tokens, TOTP secrets or recovery codes; current call sites only store
  non-secret fields and counts.

### Email

- Providers are `console`, `fake` and `resend`. Resend uses `fetch` (no SDK),
  `RESEND_API_KEY` and `EMAIL_FROM`; console logs the message for local development; fake stores
  messages for tests. Invite and reset tokens are only sent by email; in non-production with a
  non-Resend provider the management API also returns `devInviteUrl` to speed up testing.
  `forgot-password` never returns or logs the reset token.
- Email failures are logged and do not fail the underlying action (for example, a staff member is
  still invited if the provider is temporarily down). The invite link must then be re-issued.

### Open questions / operational follow-ups

- A staff admin UI is not part of this module; the Postman collection is the reference client.
- There is no automatic cleanup of expired invites, resets, sessions or login attempts. Add a
  scheduled maintenance job.
- Audit retention/export policy and SIEM shipping are not implemented. `audit:export` permission
  exists but no endpoint consumes it.
- HIBP fail-open and the Redis-less in-memory rate limits are deliberate availability choices; a
  stricter deployment should monitor provider/Redis outages and consider failing closed.
- Multi-process audit writes, cookie/IP binding policy and the current absence of per-tenant
  permission scoping need product/ops decisions before horizontal scaling.
- The CLI accepts positional `email [name]` because npm consumes `--email`/`--name` as its own
  config flags on some versions; direct `tsx src/cli/index.ts --email ...` also works.

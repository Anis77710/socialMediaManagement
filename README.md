# Redflie Business OS

Backend for a social media management product, built with Fastify 5, TypeScript, Prisma 7 and
PostgreSQL. It includes a complete customer authentication module (phone OTP, Google sign-in,
rotating refresh tokens, device sessions and anti-abuse controls) and a staff authentication module
for the admin console (invites, password + mandatory TOTP, recovery codes, opaque sessions,
step-up, RBAC, lockout, IP allow-list and an append-only audit chain).

```
backend/
  prisma/                 schema + migrations
  src/modules/auth/       customer auth service, routes, repository
  src/modules/staff/      staff auth, staff management, invites, routes
  src/cli/                bootstrap super admin / break-glass MFA reset
  src/plugins/            prisma, redis, auth, admin, security, errors, swagger
  src/providers/          SMS (Sparrow/secondary/fake/console), Google, Turnstile, email
  src/lib/                OTP, phone, tokens, TOTP, audit, permissions, rate limits
  scripts/                OpenAPI export, audit verification, TOTP helper, SQL grants
  test/                   unit, route and testcontainers integration tests
  docs/openapi.json       generated OpenAPI document
  docs/ASSUMPTIONS.md     decisions and open questions
```

## Quick start

```bash
cd backend
cp .env.example .env

# ES256 signing keys (base64-encoded PEM):
openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out private.pem
openssl pkey -in private.pem -pubout -out public.pem
# JWT_PRIVATE_KEY = base64 -w0 private.pem
# JWT_PUBLIC_KEYS = {"dev":"<base64 -w0 public.pem>"}

docker compose up -d          # PostgreSQL + Redis
npm install
npm run db:deploy             # apply migrations
npm run dev                   # customer API on :3000
npm run dev:admin             # admin API on :3001 (RUNTIME_ROLE=admin-api)
```

Required environment groups are in `backend/.env.example`: database/Redis, JWT keys, OTP pepper,
SMS provider, Google/Turnstile, CORS origins and version strings. The app refuses to boot when a
required value is missing or when `OTP_DEV_BYPASS` is set in production.

| Command | Purpose |
| --- | --- |
| `npm run dev` | Watch mode API server |
| `npm run dev:admin` | Admin API on `:3001` (`RUNTIME_ROLE=admin-api`) |
| `npm test` | Unit + route tests; testcontainers integration tests when Docker is available |
| `npm run typecheck` / `npm run lint` / `npm run build` | Static checks and production build |
| `npm run openapi:export` | Regenerate `docs/openapi.json` |
| `npm run db:migrate` / `npm run db:deploy` | Create / apply migrations |
| `npm run cli -- staff:create-superadmin <email> [name]` | Bootstrap the first super admin |
| `npm run cli -- staff:reset-mfa <email>` | Break-glass MFA reset (audited) |
| `npm run audit:verify` | Verify the audit hash chain |
| `npm run totp:code -- <BASE32_SECRET>` | Print the current TOTP code for manual testing |

## Auth API

New endpoints are mounted under `/v1/app/auth` (authenticated app) and `/v1/public/auth`.

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| POST | `/otp/request` | public / restricted Google token | Send an OTP |
| POST | `/otp/verify` | public / restricted Google token | Verify OTP and create a session |
| POST | `/google` | public | Google sign-in or phone-attach token |
| POST | `/refresh` | refresh token | Rotate refresh + access tokens |
| POST | `/logout` | bearer | Revoke the current session family |
| POST | `/logout-all` | bearer | Revoke all sessions and bump tokenVersion |
| GET | `/sessions` | bearer | List active devices |
| DELETE | `/sessions/:id` | bearer | Revoke one device family |
| GET/PATCH | `/me` | bearer | Read or update the customer |
| POST | `/phone-change/request` | bearer | OTP to a new number |
| POST | `/phone-change/confirm` | bearer | Apply the new number, revoke other sessions |
| POST | `/google/link` | bearer | Link a Google account |
| DELETE | `/google/link` | bearer | Unlink Google |
| POST | `/account/delete` | bearer | Start the deletion grace period |
| POST | `/account/delete/cancel` | bearer | Cancel deletion |
| GET | `/v1/public/auth/config` | public | Terms/privacy versions, OTP length, CAPTCHA flag |

### Web (cookie) flow

1. `POST /v1/app/auth/otp/request` with `{ "phone": "9812345678" }`.
2. `POST /v1/app/auth/otp/verify` with `{ challengeId, code, consent: { termsVersion, privacyVersion } }`.
   The response sets `__Host-rf_refresh` (`HttpOnly; Secure; SameSite=Lax; Path=/`).
3. `POST /v1/app/auth/refresh` with the cookie, an allowed `Origin`, and `X-Requested-With`.
   The response rotates the cookie. Never read the refresh cookie from JavaScript.
4. Call app endpoints with `Authorization: Bearer <accessToken>`.
5. `POST /v1/app/auth/logout` clears the cookie and revokes the session family.

### Mobile flow

Send `X-Client: mobile`. The refresh token is returned in the response body instead of a cookie:

```json
{ "accessToken": "...", "refreshToken": "...", "expiresIn": 900, "user": { "...": "..." } }
```

Refresh with `POST /v1/app/auth/refresh` and `{ "refreshToken": "..." }`. Mobile requests do not
need the Origin/X-Requested-With checks.

### Google flow for a new customer

1. `POST /v1/app/auth/google` with `{ idToken, consent }`.
2. If the Google account is unknown, the response is
   `{ "needsPhone": true, "restrictedToken": "...", "expiresIn": 900 }`.
3. `POST /v1/app/auth/otp/request` with `Authorization: Bearer <restrictedToken>` and a phone.
4. `POST /v1/app/auth/otp/verify` with the same restricted bearer token, the challenge and consent.
   A customer is created with the phone and linked Google identity. If the phone already has a
   different Google account, the API returns `409 GOOGLE_CONFLICT`.

### Security rules

- Nepali mobile numbers only: `^(96|97|98)\d{8}$`; stored as `+977...`.
- OTP: 6 digits, 5 minutes, HMAC-hashed with `OTP_PEPPER`, single use, newest challenge wins,
  five wrong attempts lock the challenge.
- Resend cooldown 45s; 3 sends per phone/15m; 8 per phone/day; 20 per IP/hour; 60 verifies per
  IP/15m; 30 refreshes per token/minute. Limits return `429` with `Retry-After`.
- CAPTCHA is required after 3 requests from one IP and once the SMS daily budget is exhausted.
  When the budget is exhausted, unknown numbers stop receiving SMS but existing accounts still do.
  An alert fires at 70% of `SMS_DAILY_CAP`.
- OTP responses are identical for known and unknown phones (except the opaque challenge id).
- Access tokens are ES256 JWTs (`sub`, `sid`, `tv`, `scp`), 15 minutes by default.
- Refresh tokens are opaque, hashed at rest, rotated on every use. Reuse inside 10 seconds returns
  `409 AUTH_REFRESH_RACE`; later reuse revokes the entire token family.
- Max 10 active session families; the oldest is evicted. `logout-all` increments `tokenVersion`,
  invalidating all access tokens immediately.
- Suspended accounts receive `403 ACCOUNT_SUSPENDED` on login, refresh and app routes. Deleted
  accounts are rejected; deletion-pending accounts can still sign in and see `deletionPending`.
- Cookies are `Secure`, all state-changing auth endpoints reject disallowed origins, and logs redact
  authorization/cookie headers, phone numbers, OTP codes and tokens.

### Error format

All errors are `application/problem+json`:

```json
{
  "type": "about:blank",
  "title": "Too Many Requests",
  "status": 429,
  "code": "AUTH_RATE_LIMITED",
  "detail": "Too many requests, try again later",
  "errors": { "retryAfterSec": 42 }
}
```

## Admin (staff) API

Start the admin server with `npm run dev:admin`, then bootstrap the first super admin:

```bash
npm run cli -- staff:create-superadmin admin@example.com "Admin Name"
# Prints a 72-hour invite URL. The invitee accepts it, then enrolls TOTP.
```

Set `ADMIN_WEB_URL`, `ADMIN_IP_ALLOWLIST` (optional CIDRs) and `EMAIL_*` in `.env`. All `/v1/admin`
routes are mounted only when `RUNTIME_ROLE=admin-api`.

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| POST | `/v1/admin/auth/login` | public | Verify email/password, return an MFA token |
| POST | `/v1/admin/auth/mfa/verify` | MFA token | Verify TOTP/recovery code, set session cookie |
| POST | `/v1/admin/auth/mfa/enroll/start` | enroll token | Start TOTP enrollment |
| POST | `/v1/admin/auth/mfa/enroll/confirm` | enroll token | Confirm TOTP, return recovery codes |
| GET | `/v1/admin/auth/invites/:token` | public | Inspect an invite |
| POST | `/v1/admin/auth/invites/accept` | public | Accept invite and set password |
| POST | `/v1/admin/auth/password/forgot` | public | Request a reset email (generic 202) |
| POST | `/v1/admin/auth/password/reset` | public | Reset with a single-use token |
| POST | `/v1/admin/auth/step-up` | session | Elevate the session for sensitive actions |
| POST | `/v1/admin/auth/logout` / `logout-all` | session | Revoke session(s) |
| GET | `/v1/admin/auth/sessions` | session | List active sessions |
| DELETE | `/v1/admin/auth/sessions/:id` | session | Revoke one session |
| GET | `/v1/admin/auth/me` | session | Current staff member + permissions |
| POST | `/v1/admin/auth/password/change` | session | Change password, revoke other sessions |
| POST | `/v1/admin/auth/mfa/recovery-codes/regenerate` | session + step-up | Replace recovery codes |
| POST | `/v1/admin/staff/invite` | `staff:manage` + step-up | Invite staff |
| GET | `/v1/admin/staff` | `staff:manage` | List staff |
| PATCH | `/v1/admin/staff/:id` | `staff:manage` + step-up | Update role/status/name |
| POST | `/v1/admin/staff/:id/reset-mfa` | `staff:manage` + step-up | Reset staff MFA |
| POST | `/v1/admin/staff/:id/revoke-sessions` | `staff:manage` + step-up | Revoke staff sessions |
| POST | `/v1/admin/impersonation` | `impersonate` + step-up | Issue a read-only customer token |

### Admin security rules

- The session cookie is `__Host-rf_admin` (`HttpOnly; Secure; SameSite=Strict`). Mutations also
  require `Origin: ADMIN_WEB_URL` and `X-CSRF-Token`. A user-agent change revokes the session; an
  IP change clears step-up. Idle timeout 30 min, absolute 8 h, max 3 sessions.
- MFA is mandatory: a valid password only returns a 5-minute pre-auth token. TOTP is 6 digits,
  30-second period, +/-30 seconds, replay-protected. Recovery codes are single-use.
- Five failed passwords lock the account for 15 minutes, doubling up to 24 hours. Login and MFA
  failures return generic errors and are rate-limited per IP.
- Roles: `SUPER_ADMIN`, `OPS`, `FINANCE`, `CONTENT`, `SUPPORT`, `REVIEWER`. The last active super
  admin cannot be demoted/disabled; staff cannot change their own role/status.
- Impersonation tokens are 30-minute ES256 customer tokens with `scp: ["app","impersonation"]`.
  They are read-only (GET/HEAD only), audited and can be used against the customer API.
- Audit rows are hash-chained and append-only. Verify with `npm run audit:verify`. Apply
  `scripts/audit-log-grants.sql` as a DBA and do not run the API as the table owner.
- See `backend/docs/ASSUMPTIONS.md` for the full decision log and operational gaps.

## Data model

`User` stores the verified E.164 phone, optional email/Google identity, locale, account status and
`tokenVersion`. `Session` holds one refresh-token family per device, rotation/revocation timestamps
and the absolute expiry floor (180 days). `OtpChallenge`, `ConsentRecord`, `SecurityEvent` and
`DenyListEntry` support OTP verification, consent audit, security events and abuse blocking.

Staff auth adds `StaffUser` (role, status, argon2 hash, encrypted TOTP secret, recovery-code hashes,
lockout counters), `StaffInvite`, `StaffPasswordReset`, `StaffSession` (opaque token hash, CSRF hash,
step-up and idle/absolute expiries) and `StaffLoginAttempt`. `AuditLog` stores the append-only staff
audit trail with `prevHash`/`rowHash` chaining. The staff migration is
`20261103033507_staff_auth`; email/status CHECK constraints enforce lowercase emails and valid
statuses at the database level.

The migration `20261102170000_customer_auth` replaces the old email/password auth. Existing users
without a phone receive a synthetic `+97798#########` number and are suspended so the synthetic
number cannot be used for account takeover. Support must verify ownership before reactivating them.
See `docs/ASSUMPTIONS.md` for migration and operational notes.

## API documentation and clients

- OpenAPI: `backend/docs/openapi.json` (`npm run openapi:export`); Swagger UI at `/docs` when
  `SWAGGER_ENABLED=true`.
- Postman: `backend/docs/redflie-auth.postman_collection.json` (customer, mobile mode) and
  `backend/docs/redflie-admin-auth.postman_collection.json` (staff flows; captures the session
  cookie and CSRF token manually because the `__Host-` cookie is Secure).

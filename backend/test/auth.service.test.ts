import { describe, expect, it } from "vitest";
import { CONSENT, IP, createHarness } from "./helpers/auth-harness.js";

const PHONE = "+9779812345678";

function codeAt(harness: ReturnType<typeof createHarness>, index: number): string {
  const match = harness.smsProvider.messages[index]?.text.match(/Redflie code: (\d{6})/);

  if (!match?.[1]) {
    throw new Error(`No SMS at index ${index}`);
  }

  return match[1];
}

function wrongCode(code: string): string {
  return code === "000000" ? "111111" : "000000";
}

describe("auth service: OTP lifecycle", () => {
  it("creates a user, records consent and issues tokens", async () => {
    const harness = createHarness();
    const result = await harness.login("9812345678");

    expect(result.isNewUser).toBe(true);
    expect(result.user.phone).toBe(PHONE);
    expect(result.accessToken).toBeTruthy();
    expect(result.refreshToken).toBeTruthy();
    expect(result.expiresIn).toBe(900);
    expect(harness.fake.consents).toHaveLength(1);
    expect(harness.fake.events.some((event) => event.type === "LOGIN_SUCCESS")).toBe(true);

    await expect(harness.service.getMe(result.user.id)).resolves.toMatchObject({
      id: result.user.id,
      phone: PHONE,
    });
  });

  it("keeps the account unknown until an OTP is verified", async () => {
    const harness = createHarness();
    const challenge = await harness.service.requestOtp({ phone: PHONE }, { ip: IP });

    expect(
      await harness.service.verifyOtp(
        {
          challengeId: challenge.challengeId,
          code: codeAt(harness, 0),
          consent: CONSENT,
        },
        { ip: IP },
      ),
    ).toMatchObject({ isNewUser: true });
    expect(harness.fake.users.size).toBe(1);
  });

  it("rejects wrong codes, expiry, superseded codes and locks after five attempts", async () => {
    const harness = createHarness();
    const challenge = await harness.service.requestOtp({ phone: PHONE }, { ip: IP });
    const code = codeAt(harness, 0);

    await expect(
      harness.service.verifyOtp(
        { challengeId: challenge.challengeId, code: wrongCode(code), consent: CONSENT },
        { ip: IP },
      ),
    ).rejects.toMatchObject({ code: "AUTH_INVALID_OTP", statusCode: 401 });

    const expiring = createHarness();
    const expiringChallenge = await expiring.service.requestOtp({ phone: PHONE }, { ip: IP });
    expiring.advance(301);
    await expect(
      expiring.service.verifyOtp(
        {
          challengeId: expiringChallenge.challengeId,
          code: codeAt(expiring, 0),
          consent: CONSENT,
        },
        { ip: IP },
      ),
    ).rejects.toMatchObject({ code: "AUTH_INVALID_OTP" });

    const superseded = createHarness();
    const first = await superseded.service.requestOtp({ phone: PHONE }, { ip: IP });
    const firstCode = codeAt(superseded, 0);
    superseded.advance(46);
    const second = await superseded.service.requestOtp({ phone: PHONE }, { ip: IP });

    await expect(
      superseded.service.verifyOtp(
        { challengeId: first.challengeId, code: firstCode, consent: CONSENT },
        { ip: IP },
      ),
    ).rejects.toMatchObject({ code: "AUTH_INVALID_OTP" });
    await expect(
      superseded.service.verifyOtp(
        { challengeId: second.challengeId, code: codeAt(superseded, 1), consent: CONSENT },
        { ip: IP },
      ),
    ).resolves.toMatchObject({ isNewUser: true });

    const locked = createHarness();
    const lockedChallenge = await locked.service.requestOtp({ phone: PHONE }, { ip: IP });
    const lockedCode = codeAt(locked, 0);

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await expect(
        locked.service.verifyOtp(
          {
            challengeId: lockedChallenge.challengeId,
            code: wrongCode(lockedCode),
            consent: CONSENT,
          },
          { ip: IP },
        ),
      ).rejects.toMatchObject({ code: "AUTH_INVALID_OTP" });
    }

    await expect(
      locked.service.verifyOtp(
        { challengeId: lockedChallenge.challengeId, code: lockedCode, consent: CONSENT },
        { ip: IP },
      ),
    ).rejects.toMatchObject({ code: "AUTH_INVALID_OTP" });
  });

  it("requires the current terms and privacy versions", async () => {
    const harness = createHarness();
    const challenge = await harness.service.requestOtp({ phone: PHONE }, { ip: IP });

    await expect(
      harness.service.verifyOtp(
        {
          challengeId: challenge.challengeId,
          code: codeAt(harness, 0),
          consent: { termsVersion: "old-terms", privacyVersion: "test-privacy" },
        },
        { ip: IP },
      ),
    ).rejects.toMatchObject({ code: "AUTH_CONSENT_REQUIRED", statusCode: 400 });

    await expect(
      harness.service.verifyOtp(
        {
          challengeId: challenge.challengeId,
          code: codeAt(harness, 0),
          consent: CONSENT,
        },
        { ip: IP },
      ),
    ).resolves.toMatchObject({ isNewUser: true });
  });

  it("returns the same shape for known and unknown phones", async () => {
    const harness = createHarness();
    await harness.fake.repo.createUser({ phoneE164: "+9779612345678", phoneVerifiedAt: new Date() });

    const unknown = await harness.service.requestOtp({ phone: "+9779812345678" }, { ip: IP });
    harness.advance(46);
    const known = await harness.service.requestOtp({ phone: "+9779612345678" }, { ip: IP });

    expect(Object.keys(unknown).sort()).toEqual(Object.keys(known).sort());
    expect(unknown.challengeId).not.toBe(known.challengeId);
    expect(harness.smsProvider.messages).toHaveLength(2);
  });
});

describe("auth service: rate limits and anti-abuse", () => {
  it("enforces the 45 second resend cooldown", async () => {
    const harness = createHarness();
    await harness.service.requestOtp({ phone: PHONE }, { ip: IP });

    const error: unknown = await harness.service
      .requestOtp({ phone: PHONE }, { ip: IP })
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: "AUTH_RATE_LIMITED", statusCode: 429 });

    const details = (error as { details?: { retryAfterSec?: number } }).details;

    expect(details?.retryAfterSec).toBeGreaterThan(0);
  });

  it("limits 3 sends per phone per 15 minutes", async () => {
    const harness = createHarness();

    for (let index = 0; index < 3; index += 1) {
      await harness.service.requestOtp(
        { phone: PHONE, captchaToken: "captcha-ok" },
        { ip: IP },
      );
      harness.advance(46);
    }

    await expect(
      harness.service.requestOtp({ phone: PHONE, captchaToken: "captcha-ok" }, { ip: IP }),
    ).rejects.toMatchObject({ code: "AUTH_RATE_LIMITED" });
  });

  it("limits 8 sends per phone per day", async () => {
    const harness = createHarness();

    for (let index = 0; index < 8; index += 1) {
      await harness.service.requestOtp(
        { phone: PHONE, captchaToken: "captcha-ok" },
        { ip: IP },
      );
      harness.advance(901);
    }

    await expect(
      harness.service.requestOtp({ phone: PHONE, captchaToken: "captcha-ok" }, { ip: IP }),
    ).rejects.toMatchObject({ code: "AUTH_RATE_LIMITED" });
  });

  it("limits 20 sends per IP per hour", async () => {
    const harness = createHarness();

    for (let index = 0; index < 20; index += 1) {
      const phone = `98123456${String(index).padStart(2, "0")}`;

      await harness.service.requestOtp({ phone, captchaToken: "captcha-ok" }, { ip: IP });
    }

    await expect(
      harness.service.requestOtp(
        { phone: "9812345699", captchaToken: "captcha-ok" },
        { ip: IP },
      ),
    ).rejects.toMatchObject({ code: "AUTH_RATE_LIMITED" });
  });

  it("limits 60 verification attempts per IP per 15 minutes", async () => {
    const harness = createHarness();

    for (let index = 0; index < 60; index += 1) {
      await expect(
        harness.service.verifyOtp(
          { challengeId: "missing", code: "123456", consent: CONSENT },
          { ip: IP },
        ),
      ).rejects.toMatchObject({ code: "AUTH_INVALID_OTP" });
    }

    await expect(
      harness.service.verifyOtp(
        { challengeId: "missing", code: "123456", consent: CONSENT },
        { ip: IP },
      ),
    ).rejects.toMatchObject({ code: "AUTH_RATE_LIMITED" });
  });

  it("limits 30 refreshes per token per minute", async () => {
    const harness = createHarness();

    for (let index = 0; index < 30; index += 1) {
      await expect(
        harness.service.refresh({ refreshToken: "unknown-token" }, { ip: IP }),
      ).rejects.toMatchObject({ code: "AUTH_INVALID_REFRESH" });
    }

    await expect(
      harness.service.refresh({ refreshToken: "unknown-token" }, { ip: IP }),
    ).rejects.toMatchObject({ code: "AUTH_RATE_LIMITED" });
  });

  it("requires CAPTCHA after three requests from one IP", async () => {
    const harness = createHarness();

    for (let index = 0; index < 4; index += 1) {
      await harness.limiter.increment(`captcha:ip:${IP}`, 3600);
    }

    await expect(
      harness.service.requestOtp({ phone: PHONE }, { ip: IP }),
    ).rejects.toMatchObject({ code: "AUTH_CAPTCHA_REQUIRED", statusCode: 403 });

    await expect(
      harness.service.requestOtp({ phone: PHONE }, { ip: IP }),
    ).rejects.toMatchObject({ code: "AUTH_CAPTCHA_REQUIRED" });

    const captchaPassed = await harness.service.requestOtp(
      { phone: PHONE, captchaToken: "captcha-ok" },
      { ip: IP },
    );

    expect(captchaPassed.challengeId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("stops SMS above the daily cap but keeps OTP for known accounts", async () => {
    const harness = createHarness({ config: { smsDailyCap: 1 } });

    await harness.service.requestOtp({ phone: "+9779812345678" }, { ip: IP });
    harness.advance(46);
    await harness.service.requestOtp(
      { phone: "+9779612345678", captchaToken: "captcha-ok" },
      { ip: IP },
    );

    expect(harness.smsProvider.messages).toHaveLength(1);

    await harness.fake.repo.createUser({
      phoneE164: "+9779712345678",
      phoneVerifiedAt: new Date(),
    });
    harness.advance(46);
    await harness.service.requestOtp(
      { phone: "+9779712345678", captchaToken: "captcha-ok" },
      { ip: IP },
    );

    expect(harness.smsProvider.messages).toHaveLength(2);
    expect(harness.smsProvider.messages[1]?.to).toBe("+9779712345678");
  });

  it("alerts once when the daily budget reaches 70%", async () => {
    const harness = createHarness({ config: { smsDailyCap: 10 } });

    for (let index = 0; index < 7; index += 1) {
      await harness.service.requestOtp(
        { phone: `98123456${String(index).padStart(2, "0")}`, captchaToken: "captcha-ok" },
        { ip: IP },
      );
    }

    expect(harness.alerts).toEqual(["SMS daily budget has reached 70%"]);
  });
});

describe("auth service: refresh rotation", () => {
  it("rotates tokens, reports races inside 10s, and revokes the family on reuse", async () => {
    const harness = createHarness();
    const login = await harness.login(PHONE);

    const rotated = await harness.service.refresh(
      { refreshToken: login.refreshToken },
      { ip: IP },
    );

    await expect(
      harness.service.refresh({ refreshToken: login.refreshToken }, { ip: IP }),
    ).rejects.toMatchObject({ code: "AUTH_REFRESH_RACE", statusCode: 409 });

    harness.advance(11);

    const second = await harness.service.refresh(
      { refreshToken: rotated.refreshToken },
      { ip: IP },
    );

    await expect(
      harness.service.refresh({ refreshToken: login.refreshToken }, { ip: IP }),
    ).rejects.toMatchObject({ code: "AUTH_REFRESH_REUSE", statusCode: 401 });

    await expect(
      harness.service.refresh({ refreshToken: second.refreshToken }, { ip: IP }),
    ).rejects.toMatchObject({ code: "AUTH_INVALID_REFRESH" });
    expect(
      harness.fake.events.some(
        (event) => event.type === "REFRESH_REUSE" && event.result === "BLOCKED",
      ),
    ).toBe(true);
  });

  it("rejects expired, suspended and deleted sessions", async () => {
    const expired = createHarness();
    const expiredLogin = await expired.login(PHONE);
    expired.advance(181 * 86_400);

    await expect(
      expired.service.refresh({ refreshToken: expiredLogin.refreshToken }, { ip: IP }),
    ).rejects.toMatchObject({ code: "AUTH_INVALID_REFRESH" });

    const suspended = createHarness();
    const suspendedLogin = await suspended.login(PHONE);
    await suspended.fake.repo.updateUser(suspendedLogin.user.id, { status: "SUSPENDED" });

    await expect(
      suspended.service.refresh({ refreshToken: suspendedLogin.refreshToken }, { ip: IP }),
    ).rejects.toMatchObject({ code: "ACCOUNT_SUSPENDED", statusCode: 403 });

    const deleted = createHarness();
    const deletedLogin = await deleted.login(PHONE);
    await deleted.fake.repo.updateUser(deletedLogin.user.id, { status: "DELETED" });

    await expect(
      deleted.service.refresh({ refreshToken: deletedLogin.refreshToken }, { ip: IP }),
    ).rejects.toMatchObject({ code: "AUTH_INVALID_REFRESH" });
  });

  it("issues a fresh family when the device is new and emits an event", async () => {
    const harness = createHarness();
    await harness.login(PHONE, { name: "iPhone", platform: "ios" });
    harness.advance(46);
    await harness.login(PHONE, { name: "iPhone", platform: "ios" });
    harness.advance(46);
    await harness.login(PHONE, { name: "Pixel", platform: "android" }, "captcha-ok");

    expect(
      harness.emitted.filter((event) => event.type === "NEW_DEVICE_LOGIN"),
    ).toHaveLength(1);
  });
});

describe("auth service: sessions", () => {
  it("lists, marks current and revokes sessions", async () => {
    const harness = createHarness();
    const first = await harness.login(PHONE, { name: "One" });
    harness.advance(46);
    const second = await harness.login(PHONE, { name: "Two" });

    const sessions = await harness.service.listSessions(second.user.id, second.sessionId);

    expect(sessions).toHaveLength(2);
    expect(sessions.find((session) => session.id === second.sessionId)?.current).toBe(true);
    expect(sessions.find((session) => session.id === first.sessionId)?.current).toBe(false);

    await harness.service.revokeSession(first.user.id, first.sessionId, { ip: IP });
    await expect(
      harness.service.listSessions(second.user.id, second.sessionId),
    ).resolves.toHaveLength(1);
    await expect(
      harness.service.revokeSession(second.user.id, "missing", { ip: IP }),
    ).rejects.toMatchObject({ code: "AUTH_SESSION_NOT_FOUND" });
  });

  it("logout-all revokes every session and bumps tokenVersion", async () => {
    const harness = createHarness();
    const first = await harness.login(PHONE);
    harness.advance(46);
    const second = await harness.login(PHONE);

    await harness.service.logoutAll(first.user.id, { ip: IP });

    const user = await harness.fake.repo.findUserById(first.user.id);

    expect(user?.tokenVersion).toBe(1);
    await expect(
      harness.service.listSessions(first.user.id, first.sessionId),
    ).resolves.toHaveLength(0);
    await expect(harness.revocations.isRevoked(first.sessionId)).resolves.toBe(true);
    await expect(harness.revocations.isRevoked(second.sessionId)).resolves.toBe(true);
  });
});

describe("auth service: Google", () => {
  it("logs in a linked Google account and asks unknown identities for a phone", async () => {
    const harness = createHarness();
    const user = await harness.fake.repo.createUser({
      phoneE164: PHONE,
      googleSub: "google-known",
      email: "known@example.com",
      name: "Known",
      phoneVerifiedAt: new Date(),
    });
    harness.identities.set("id-known", {
      sub: "google-known",
      email: "known@example.com",
      name: "Known",
    });

    const login = await harness.service.googleLogin(
      { idToken: "id-known", consent: CONSENT },
      { ip: IP },
    );

    expect(login).toMatchObject({ needsPhone: false, user: { id: user.id } });

    harness.identities.set("id-new", { sub: "google-new", email: "new@example.com" });
    const pending = await harness.service.googleLogin(
      { idToken: "id-new", consent: CONSENT },
      { ip: IP },
    );

    expect(pending).toMatchObject({ needsPhone: true, expiresIn: 900 });

    if (!pending.needsPhone) {
      throw new Error("expected needsPhone");
    }

    await expect(harness.tokens.verifyRestricted(pending.restrictedToken)).resolves.toMatchObject({
      gsub: "google-new",
    });
  });

  it("attaches Google to a phone verified by OTP", async () => {
    const harness = createHarness();
    harness.identities.set("id-attach", {
      sub: "google-attach",
      email: "attach@example.com",
      name: "Attach",
    });
    const pending = await harness.service.googleLogin(
      { idToken: "id-attach", consent: CONSENT },
      { ip: IP },
    );

    if (!pending.needsPhone) {
      throw new Error("expected needsPhone");
    }

    const claims = await harness.tokens.verifyRestricted(pending.restrictedToken);
    const challenge = await harness.service.requestGoogleAttachOtp(
      { phone: PHONE },
      { ip: IP },
    );
    const login = await harness.service.verifyOtp(
      { challengeId: challenge.challengeId, code: codeAt(harness, 0), consent: CONSENT },
      { ip: IP },
      { sub: claims.gsub, ...(claims.gemail ? { email: claims.gemail } : {}) },
    );

    expect(login.user).toMatchObject({
      phone: PHONE,
      email: "attach@example.com",
      hasGoogle: true,
    });

    harness.identities.set("id-attach", { sub: "google-attach" });
    await expect(
      harness.service.googleLogin({ idToken: "id-attach", consent: CONSENT }, { ip: IP }),
    ).resolves.toMatchObject({ needsPhone: false, isNewUser: false });
  });

  it("refuses to overwrite a different linked Google account", async () => {
    const harness = createHarness();
    await harness.fake.repo.createUser({
      phoneE164: PHONE,
      googleSub: "google-old",
      phoneVerifiedAt: new Date(),
    });

    const challenge = await harness.service.requestGoogleAttachOtp(
      { phone: PHONE },
      { ip: IP },
    );

    await expect(
      harness.service.verifyOtp(
        { challengeId: challenge.challengeId, code: codeAt(harness, 0), consent: CONSENT },
        { ip: IP },
        { sub: "google-new" },
      ),
    ).rejects.toMatchObject({ code: "GOOGLE_CONFLICT", statusCode: 409 });
  });

  it("rejects invalid, suspended and unavailable Google logins", async () => {
    const harness = createHarness();

    await expect(
      harness.service.googleLogin({ idToken: "bad", consent: CONSENT }, { ip: IP }),
    ).rejects.toMatchObject({ code: "AUTH_INVALID_GOOGLE_TOKEN", statusCode: 401 });

    const user = await harness.fake.repo.createUser({
      phoneE164: PHONE,
      googleSub: "google-suspended",
      phoneVerifiedAt: new Date(),
    });
    await harness.fake.repo.updateUser(user.id, { status: "SUSPENDED" });
    harness.identities.set("id-suspended", { sub: "google-suspended" });

    await expect(
      harness.service.googleLogin({ idToken: "id-suspended", consent: CONSENT }, { ip: IP }),
    ).rejects.toMatchObject({ code: "ACCOUNT_SUSPENDED", statusCode: 403 });
  });
});

describe("auth service: account state and profile", () => {
  it("blocks suspended accounts, flags pending deletion and rejects deleted ones", async () => {
    const suspended = createHarness();
    const suspendedUser = await suspended.fake.repo.createUser({
      phoneE164: PHONE,
      phoneVerifiedAt: new Date(),
    });
    await suspended.fake.repo.updateUser(suspendedUser.id, { status: "SUSPENDED" });
    const suspendedChallenge = await suspended.service.requestOtp({ phone: PHONE }, { ip: IP });

    await expect(
      suspended.service.verifyOtp(
        {
          challengeId: suspendedChallenge.challengeId,
          code: codeAt(suspended, 0),
          consent: CONSENT,
        },
        { ip: IP },
      ),
    ).rejects.toMatchObject({ code: "ACCOUNT_SUSPENDED", statusCode: 403 });

    const pending = createHarness();
    const pendingUser = await pending.fake.repo.createUser({
      phoneE164: PHONE,
      phoneVerifiedAt: new Date(),
    });
    await pending.fake.repo.setDeletion(pendingUser.id, new Date());
    const pendingChallenge = await pending.service.requestOtp({ phone: PHONE }, { ip: IP });
    const pendingLogin = await pending.service.verifyOtp(
      {
        challengeId: pendingChallenge.challengeId,
        code: codeAt(pending, 0),
        consent: CONSENT,
      },
      { ip: IP },
    );

    expect(pendingLogin.deletionPending).toBe(true);

    const deleted = createHarness();
    const deletedUser = await deleted.fake.repo.createUser({
      phoneE164: PHONE,
      phoneVerifiedAt: new Date(),
    });
    await deleted.fake.repo.updateUser(deletedUser.id, { status: "DELETED" });
    const deletedChallenge = await deleted.service.requestOtp({ phone: PHONE }, { ip: IP });

    await expect(
      deleted.service.verifyOtp(
        {
          challengeId: deletedChallenge.challengeId,
          code: codeAt(deleted, 0),
          consent: CONSENT,
        },
        { ip: IP },
      ),
    ).rejects.toMatchObject({ code: "AUTH_INVALID_OTP" });
  });

  it("updates profile and toggles deletion requests", async () => {
    const harness = createHarness();
    const login = await harness.login(PHONE);

    await expect(
      harness.service.updateMe(login.user.id, { name: "Anish", locale: "EN" }),
    ).resolves.toMatchObject({ name: "Anish", locale: "EN" });

    await harness.service.requestAccountDeletion(login.user.id, { ip: IP });
    await expect(harness.service.getMe(login.user.id)).resolves.toMatchObject({
      status: "DELETION_PENDING",
    });

    await harness.service.cancelAccountDeletion(login.user.id, { ip: IP });
    await expect(harness.service.getMe(login.user.id)).resolves.toMatchObject({
      status: "ACTIVE",
    });
  });

  it("changes the phone number and frees the old one", async () => {
    const harness = createHarness();
    const login = await harness.login(PHONE);
    const change = await harness.service.requestPhoneChange(
      login.user.id,
      { newPhone: "9812399999" },
      { ip: IP },
    );

    await harness.service.confirmPhoneChange(
      login.user.id,
      login.sessionId,
      { challengeId: change.challengeId, code: codeAt(harness, 1) },
      { ip: IP },
    );

    await expect(harness.service.getMe(login.user.id)).resolves.toMatchObject({
      phone: "+9779812399999",
    });

    harness.advance(46);
    const oldPhoneLogin = await harness.login(PHONE, undefined, "captcha-ok");

    expect(oldPhoneLogin.isNewUser).toBe(true);
    expect(oldPhoneLogin.user.id).not.toBe(login.user.id);
  });

  it("refuses a new phone that belongs to another account, even if deleted", async () => {
    const harness = createHarness();
    const login = await harness.login(PHONE);
    const other = await harness.fake.repo.createUser({
      phoneE164: "+9779812399999",
      phoneVerifiedAt: new Date(),
    });

    await expect(
      harness.service.requestPhoneChange(
        login.user.id,
        { newPhone: "9812399999" },
        { ip: IP },
      ),
    ).rejects.toMatchObject({ code: "AUTH_PHONE_IN_USE", statusCode: 409 });

    await harness.fake.repo.updateUser(other.id, { status: "DELETED" });

    await expect(
      harness.service.requestPhoneChange(
        login.user.id,
        { newPhone: "9812399999" },
        { ip: IP },
      ),
    ).rejects.toMatchObject({ code: "AUTH_PHONE_IN_USE", statusCode: 409 });
  });

  it("publishes OTP config and flips captchaRequired at the daily cap", async () => {
    const harness = createHarness({ config: { smsDailyCap: 2 } });

    await expect(harness.service.publicConfig()).resolves.toMatchObject({
      termsVersion: "test-terms",
      privacyVersion: "test-privacy",
      otpLength: 6,
      otpTtlSec: 300,
      captchaRequired: false,
    });

    await harness.service.requestOtp({ phone: PHONE }, { ip: IP });
    harness.advance(46);
    await harness.service.requestOtp({ phone: "+9779612345678" }, { ip: IP });

    await expect(harness.service.publicConfig()).resolves.toMatchObject({
      captchaRequired: true,
    });
  });
});

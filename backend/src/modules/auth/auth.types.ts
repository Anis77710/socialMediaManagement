export type UserStatusValue = "ACTIVE" | "SUSPENDED" | "DELETION_PENDING" | "DELETED";
export type Locale = "NE" | "EN";

export type UserRecord = {
  id: string;
  phoneE164: string;
  phoneVerifiedAt: Date | null;
  email: string | null;
  googleSub: string | null;
  name: string | null;
  locale: Locale;
  status: UserStatusValue;
  tokenVersion: number;
  lastLoginAt: Date | null;
  deletionRequestedAt: Date | null;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type SessionRecord = {
  id: string;
  userId: string;
  familyId: string;
  tokenHash: string;
  replacedById: string | null;
  rotatedAt: Date | null;
  deviceName: string | null;
  platform: string | null;
  userAgent: string | null;
  ip: string | null;
  expiresAt: Date;
  absoluteExpiresAt: Date;
  revokedAt: Date | null;
  revokeReason: string | null;
  lastUsedAt: Date | null;
  createdAt: Date;
};

export type ChallengeRecord = {
  id: string;
  phoneE164: string;
  purpose: string;
  codeHash: string;
  attempts: number;
  sendCount: number;
  userId: string | null;
  ip: string | null;
  expiresAt: Date;
  consumedAt: Date | null;
  createdAt: Date;
};

export type DeviceInfo = {
  name?: string;
  platform?: string;
};

export type RequestContext = {
  ip?: string;
  userAgent?: string;
};

export type SecurityEventInput = {
  type: string;
  userId?: string | null;
  phoneHash?: string | null;
  phoneMasked?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  result: "OK" | "FAIL" | "BLOCKED";
  meta?: Record<string, unknown>;
};

export type UserUpdate = Partial<{
  phoneE164: string;
  phoneVerifiedAt: Date | null;
  email: string | null;
  googleSub: string | null;
  name: string | null;
  locale: Locale;
  status: UserStatusValue;
  lastLoginAt: Date | null;
  deletionRequestedAt: Date | null;
  deletedAt: Date | null;
}>;

export type CreateUserInput = {
  phoneE164: string;
  phoneVerifiedAt?: Date | null;
  googleSub?: string | null;
  email?: string | null;
  name?: string | null;
};

export type CreateChallengeInput = {
  id: string;
  phoneE164: string;
  purpose: string;
  codeHash: string;
  userId?: string | null;
  ip?: string | null;
  expiresAt: Date;
};

export type CreateSessionInput = {
  userId: string;
  familyId: string;
  tokenHash: string;
  deviceName?: string | null;
  platform?: string | null;
  userAgent?: string | null;
  ip?: string | null;
  expiresAt: Date;
  absoluteExpiresAt: Date;
  lastUsedAt?: Date;
};

export type ConsentInput = {
  userId: string;
  termsVersion: string;
  privacyVersion: string;
  ip?: string | null;
  acceptedAt: Date;
};

export type DenyKind = "PHONE" | "IP" | "CIDR";

export type AuthRepo = {
  findUserByPhone(phoneE164: string): Promise<UserRecord | null>;
  findUserByGoogleSub(googleSub: string): Promise<UserRecord | null>;
  findUserById(id: string): Promise<UserRecord | null>;
  createUser(input: CreateUserInput): Promise<UserRecord>;
  updateUser(id: string, data: UserUpdate): Promise<UserRecord>;
  incrementTokenVersion(id: string): Promise<number>;
  createChallenge(input: CreateChallengeInput): Promise<ChallengeRecord>;
  findChallenge(id: string): Promise<ChallengeRecord | null>;
  findLatestChallenge(phoneE164: string, purpose: string): Promise<ChallengeRecord | null>;
  incrementChallengeAttempts(id: string): Promise<number>;
  consumeChallenge(id: string, at: Date): Promise<void>;
  createSession(input: CreateSessionInput): Promise<SessionRecord>;
  findSessionByTokenHash(tokenHash: string): Promise<SessionRecord | null>;
  findSessionById(id: string): Promise<SessionRecord | null>;
  markSessionRotated(id: string, replacedById: string, rotatedAt: Date): Promise<boolean>;
  revokeSession(id: string, reason: string, at: Date): Promise<void>;
  revokeFamily(familyId: string, reason: string, at: Date): Promise<string[]>;
  revokeAllSessions(userId: string, reason: string, at: Date): Promise<string[]>;
  listSessionIdsByFamily(familyId: string): Promise<string[]>;
  listActiveSessions(userId: string, now: Date): Promise<SessionRecord[]>;
  countActiveFamilies(userId: string, now: Date): Promise<number>;
  oldestActiveFamily(userId: string, now: Date): Promise<string | null>;
  hasSeenDevice(userId: string, device: DeviceInfo): Promise<boolean>;
  touchSession(id: string, at: Date): Promise<void>;
  createConsents(input: ConsentInput): Promise<void>;
  createSecurityEvent(event: SecurityEventInput): Promise<void>;
  isDenied(kind: DenyKind, value: string, now: Date): Promise<boolean>;
  listActiveCidrs(now: Date): Promise<string[]>;
  changePhone(
    userId: string,
    newPhone: string,
    keepFamilyId: string,
    reason: string,
    at: Date,
  ): Promise<string[]>;
  linkGoogle(userId: string, googleSub: string, email: string | null): Promise<void>;
  unlinkGoogle(userId: string): Promise<void>;
  setDeletion(userId: string, requestedAt: Date | null): Promise<void>;
};

export class UniqueConflictError extends Error {
  constructor(message = "A record with these values already exists") {
    super(message);
    this.name = "UniqueConflictError";
  }
}

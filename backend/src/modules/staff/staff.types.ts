import type { StaffRole } from "../../lib/permissions.js";

export type StaffStatus = "INVITED" | "ACTIVE" | "DISABLED";

export type StaffRecord = {
  id: string;
  email: string;
  name: string;
  role: StaffRole;
  status: StaffStatus;
  passwordHash: string | null;
  passwordChangedAt: Date | null;
  totpSecretEnc: string | null;
  totpLastStep: bigint | null;
  mfaEnabledAt: Date | null;
  recoveryCodeHashes: string[];
  failedLogins: number;
  lockedUntil: Date | null;
  lastLoginAt: Date | null;
  lastLoginIp: string | null;
  createdById: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type StaffUpdate = Partial<
  Pick<
    StaffRecord,
    | "name"
    | "role"
    | "status"
    | "passwordHash"
    | "passwordChangedAt"
    | "totpSecretEnc"
    | "totpLastStep"
    | "mfaEnabledAt"
    | "recoveryCodeHashes"
    | "failedLogins"
    | "lockedUntil"
    | "lastLoginAt"
    | "lastLoginIp"
  >
>;

export type CreateStaffInput = {
  email: string;
  name: string;
  role: StaffRole;
  status?: StaffStatus;
  createdById?: string | null;
};

export type StaffInviteRecord = {
  id: string;
  email: string;
  role: StaffRole;
  tokenHash: string;
  invitedById: string;
  expiresAt: Date;
  acceptedAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
};

export type StaffPasswordResetRecord = {
  id: string;
  staffId: string;
  tokenHash: string;
  expiresAt: Date;
  usedAt: Date | null;
  createdAt: Date;
};

export type StaffSessionRecord = {
  id: string;
  staffId: string;
  tokenHash: string;
  csrfHash: string;
  ip: string | null;
  userAgent: string | null;
  stepUpUntil: Date | null;
  idleExpiresAt: Date;
  absoluteExpiresAt: Date;
  lastSeenAt: Date | null;
  revokedAt: Date | null;
  revokeReason: string | null;
  createdAt: Date;
};

export type StaffSessionUpdate = Partial<
  Pick<
    StaffSessionRecord,
    "stepUpUntil" | "idleExpiresAt" | "lastSeenAt" | "revokedAt" | "revokeReason"
  >
>;

export type LoginAttemptInput = {
  emailHash: string;
  ip: string;
  success: boolean;
  reason?: string | null;
  at?: Date;
};

export type RequestContext = {
  ip?: string;
  userAgent?: string;
  requestId?: string;
};

export type CustomerSummary = {
  id: string;
  name: string | null;
  phoneE164: string;
  status: string;
};

export type StaffRepo = {
  findStaffByEmail(email: string): Promise<StaffRecord | null>;
  findStaffById(id: string): Promise<StaffRecord | null>;
  createStaff(input: CreateStaffInput): Promise<StaffRecord>;
  updateStaff(id: string, data: StaffUpdate): Promise<StaffRecord>;
  listStaff(input: {
    page: number;
    limit: number;
    search?: string;
    role?: StaffRole;
    status?: StaffStatus;
  }): Promise<{ rows: StaffRecord[]; total: number }>;
  listSuperAdmins(): Promise<StaffRecord[]>;
  countActiveSuperAdmins(exceptId?: string): Promise<number>;
  incrementFailedLogins(id: string): Promise<number>;
  resetFailedLogins(id: string, at: Date, ip: string | null): Promise<void>;

  createInvite(input: {
    email: string;
    role: StaffRole;
    tokenHash: string;
    invitedById: string;
    expiresAt: Date;
  }): Promise<StaffInviteRecord>;
  findInviteByTokenHash(tokenHash: string): Promise<StaffInviteRecord | null>;
  acceptInvite(id: string, at: Date): Promise<boolean>;
  revokePendingInvites(email: string, at: Date): Promise<void>;

  createPasswordReset(input: {
    staffId: string;
    tokenHash: string;
    expiresAt: Date;
  }): Promise<StaffPasswordResetRecord>;
  findPasswordResetByTokenHash(tokenHash: string): Promise<StaffPasswordResetRecord | null>;
  usePasswordReset(id: string, at: Date): Promise<boolean>;

  createStaffSession(input: {
    staffId: string;
    tokenHash: string;
    csrfHash: string;
    ip?: string | null;
    userAgent?: string | null;
    idleExpiresAt: Date;
    absoluteExpiresAt: Date;
  }): Promise<StaffSessionRecord>;
  findStaffSessionByTokenHash(tokenHash: string): Promise<StaffSessionRecord | null>;
  findStaffSessionById(id: string): Promise<StaffSessionRecord | null>;
  updateStaffSession(id: string, data: StaffSessionUpdate): Promise<void>;
  revokeStaffSession(id: string, reason: string, at: Date): Promise<void>;
  revokeAllStaffSessions(
    staffId: string,
    reason: string,
    at: Date,
    exceptSessionId?: string,
  ): Promise<string[]>;
  listActiveStaffSessions(staffId: string, now: Date): Promise<StaffSessionRecord[]>;
  countActiveStaffSessions(staffId: string, now: Date): Promise<number>;
  oldestActiveStaffSession(staffId: string, now: Date): Promise<StaffSessionRecord | null>;

  recordLoginAttempt(input: LoginAttemptInput): Promise<void>;
  countLoginFailuresSince(emailHash: string, since: Date): Promise<number>;

  findCustomer(id: string): Promise<CustomerSummary | null>;
  createSecurityEvent(input: {
    type: string;
    userId?: string | null;
    ip?: string | null;
    userAgent?: string | null;
    result: "OK" | "FAIL" | "BLOCKED";
    meta?: Record<string, unknown>;
  }): Promise<void>;
};

export type StaffView = {
  id: string;
  email: string;
  name: string;
  role: StaffRole;
  status: StaffStatus;
  mfaEnabled: boolean;
  permissions: string[];
  lastLoginAt: Date | null;
};

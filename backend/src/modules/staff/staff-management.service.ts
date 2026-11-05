import { randomBytes } from "node:crypto";
import type { AuditWriter } from "../../lib/audit.js";
import { hashToken } from "../../lib/crypto.js";
import { AppError } from "../../lib/errors.js";
import { maskPhone } from "../../lib/phone.js";
import { permissionsFor, type StaffRole } from "../../lib/permissions.js";
import type { TokenService } from "../../lib/tokens.js";
import type { EmailProvider } from "../../providers/email/types.js";
import { inviteEmail, securityAlertEmail } from "./staff.emails.js";
import { normalizeEmail } from "./staff-auth.service.js";
import type {
  RequestContext,
  StaffRecord,
  StaffRepo,
  StaffStatus,
  StaffView,
} from "./staff.types.js";

type Logger = {
  info(object: Record<string, unknown>, message: string): void;
  warn(object: Record<string, unknown>, message: string): void;
};

export type StaffManagementConfig = {
  adminWebUrl: string;
  inviteTtlSec: number;
  exposeDevTokens: boolean;
};

export type StaffManagementService = ReturnType<typeof createStaffManagementService>;

function view(staff: StaffRecord): StaffView {
  return {
    id: staff.id,
    email: staff.email,
    name: staff.name,
    role: staff.role,
    status: staff.status,
    mfaEnabled: staff.mfaEnabledAt !== null,
    permissions: [...permissionsFor(staff.role)],
    lastLoginAt: staff.lastLoginAt,
  };
}

export function createStaffManagementService(options: {
  repo: StaffRepo;
  audit: AuditWriter;
  email: EmailProvider;
  tokens: TokenService;
  config: StaffManagementConfig;
  log: Logger;
  now?: () => Date;
  onEvent?: (type: string, payload: Record<string, unknown>) => void;
  onSessionsRevoked?: (sessionIds: string[]) => Promise<void> | void;
}) {
  const { repo, audit, email, tokens, config, log } = options;
  const now = options.now ?? (() => new Date());

  async function notifyRevoked(sessionIds: string[]): Promise<void> {
    if (sessionIds.length === 0 || !options.onSessionsRevoked) {
      return;
    }

    try {
      await options.onSessionsRevoked(sessionIds);
    } catch (error) {
      log.warn({ error, sessionIds }, "admin_session_cache_invalidation_failed");
    }
  }

  async function sendEmail(message: Parameters<EmailProvider["send"]>[0]): Promise<void> {
    try {
      await email.send(message);
    } catch (error) {
      log.warn({ error, to: message.to }, "staff_email_send_failed");
    }
  }

  async function alertSuperAdmins(message: string, actorEmail?: string): Promise<void> {
    const admins = await repo.listSuperAdmins();

    await Promise.all(
      admins
        .filter((admin) => admin.email !== actorEmail)
        .map((admin) =>
          sendEmail(
            securityAlertEmail({
              email: admin.email,
              message,
              ...(actorEmail ? { actorEmail } : {}),
            }),
          ),
        ),
    );
  }

  async function getTarget(targetId: string): Promise<StaffRecord> {
    const target = await repo.findStaffById(targetId);

    if (!target) {
      throw AppError.notFound("Staff member not found");
    }

    return target;
  }

  return {
    async createInvite(
      actor: StaffRecord,
      input: { email: string; name?: string; role: StaffRole },
      ctx: RequestContext,
    ): Promise<{
      id: string;
      email: string;
      role: StaffRole;
      expiresAt: Date;
      devInviteUrl?: string;
    }> {
      const emailAddress = normalizeEmail(input.email);
      const existing = await repo.findStaffByEmail(emailAddress);

      if (existing && existing.status !== "INVITED") {
        throw new AppError(409, "STAFF_EXISTS", "A staff member with this email already exists");
      }

      if (existing && existing.id === actor.id) {
        throw new AppError(409, "STAFF_EXISTS", "You are already a staff member");
      }

      const staff = existing
        ? await repo.updateStaff(existing.id, {
            name: input.name?.trim() || existing.name,
            role: input.role,
          })
        : await repo.createStaff({
            email: emailAddress,
            name: input.name?.trim() || emailAddress.split("@")[0] || emailAddress,
            role: input.role,
            createdById: actor.id,
          });

      await repo.revokePendingInvites(emailAddress, now());

      const token = randomBytes(32).toString("base64url");
      const expiresAt = new Date(now().getTime() + config.inviteTtlSec * 1000);
      await repo.createInvite({
        email: emailAddress,
        role: input.role,
        tokenHash: hashToken(token),
        invitedById: actor.id,
        expiresAt,
      });

      const url = new URL("/accept-invite", config.adminWebUrl);
      url.searchParams.set("token", token);

      await sendEmail(
        inviteEmail({
          email: emailAddress,
          role: input.role,
          inviteUrl: url.toString(),
          expiresAt,
        }),
      );

      await audit.write({
        actorType: "STAFF",
        actorId: actor.id,
        action: "staff.invited",
        entityType: "StaffUser",
        entityId: staff.id,
        after: { email: emailAddress, role: input.role },
        ip: ctx.ip ?? null,
        requestId: ctx.requestId ?? null,
      });

      return {
        id: staff.id,
        email: staff.email,
        role: staff.role,
        expiresAt,
        ...(config.exposeDevTokens ? { devInviteUrl: url.toString() } : {}),
      };
    },

    async listStaff(input: {
      page: number;
      limit: number;
      search?: string;
      role?: StaffRole;
      status?: StaffStatus;
    }) {
      return repo.listStaff(input);
    },

    async updateStaff(
      actor: StaffRecord,
      targetId: string,
      input: { name?: string; role?: StaffRole; status?: StaffStatus },
      ctx: RequestContext,
    ): Promise<StaffView> {
      const target = await getTarget(targetId);

      if (target.id === actor.id && (input.role || input.status)) {
        throw new AppError(
          400,
          "STAFF_SELF_UPDATE",
          "You cannot change your own role or status",
        );
      }

      if (input.status === "INVITED") {
        throw new AppError(400, "BAD_REQUEST", "Cannot set status to INVITED");
      }

      if (
        target.role === "SUPER_ADMIN" &&
        target.status === "ACTIVE" &&
        ((input.role && input.role !== "SUPER_ADMIN") || input.status === "DISABLED")
      ) {
        const others = await repo.countActiveSuperAdmins(target.id);

        if (others === 0) {
          throw new AppError(
            409,
            "LAST_SUPER_ADMIN",
            "The last active super admin cannot be demoted or disabled",
          );
        }
      }

      if (input.status === "ACTIVE" && !target.passwordHash) {
        throw new AppError(409, "INVITE_PENDING", "This staff member has not accepted their invite");
      }

      const updated = await repo.updateStaff(target.id, {
        ...(input.name !== undefined ? { name: input.name.trim() } : {}),
        ...(input.role ? { role: input.role } : {}),
        ...(input.status ? { status: input.status } : {}),
      });

      if (input.status === "DISABLED") {
        const revoked = await repo.revokeAllStaffSessions(target.id, "disabled", now());
        await notifyRevoked(revoked);
      }

      await audit.write({
        actorType: "STAFF",
        actorId: actor.id,
        action: "staff.updated",
        entityType: "StaffUser",
        entityId: target.id,
        before: { name: target.name, role: target.role, status: target.status },
        after: { name: updated.name, role: updated.role, status: updated.status },
        ip: ctx.ip ?? null,
        requestId: ctx.requestId ?? null,
      });

      if (input.role || input.status) {
        await sendEmail(
          securityAlertEmail({
            email: target.email,
            message: `Your Redflie admin account was updated by ${actor.email}. Role: ${updated.role}. Status: ${updated.status}.`,
          }),
        );
        await alertSuperAdmins(
          `Staff member ${target.email} was updated by ${actor.email} (role ${updated.role}, status ${updated.status}).`,
          actor.email,
        );
      }

      return view(updated);
    },

    async resetMfa(
      actor: StaffRecord,
      targetId: string,
      ctx: RequestContext,
    ): Promise<void> {
      const target = await getTarget(targetId);

      if (!target.mfaEnabledAt && !target.totpSecretEnc) {
        throw new AppError(409, "MFA_NOT_ENROLLED", "Multi-factor authentication is not set up");
      }

      await repo.updateStaff(target.id, {
        totpSecretEnc: null,
        totpLastStep: null,
        mfaEnabledAt: null,
        recoveryCodeHashes: [],
      });
      const revoked = await repo.revokeAllStaffSessions(target.id, "mfa_reset", now());
      await notifyRevoked(revoked);

      await audit.write({
        actorType: "STAFF",
        actorId: actor.id,
        action: "staff.mfa_reset",
        entityType: "StaffUser",
        entityId: target.id,
        before: { mfaEnabled: true },
        after: { mfaEnabled: false },
        ip: ctx.ip ?? null,
        requestId: ctx.requestId ?? null,
      });

      await sendEmail(
        securityAlertEmail({
          email: target.email,
          message: `Your multi-factor authentication was reset by ${actor.email}. You must enroll again at your next sign-in.`,
        }),
      );
      await alertSuperAdmins(
        `MFA was reset for ${target.email} by ${actor.email}.`,
        actor.email,
      );
    },

    async revokeSessions(
      actor: StaffRecord,
      targetId: string,
      ctx: RequestContext,
    ): Promise<{ revoked: number }> {
      const target = await getTarget(targetId);
      const ids = await repo.revokeAllStaffSessions(target.id, "revoked_by_admin", now());
      await notifyRevoked(ids);

      await audit.write({
        actorType: "STAFF",
        actorId: actor.id,
        action: "staff.sessions_revoked",
        entityType: "StaffUser",
        entityId: target.id,
        after: { revoked: ids.length },
        ip: ctx.ip ?? null,
        requestId: ctx.requestId ?? null,
      });

      await sendEmail(
        securityAlertEmail({
          email: target.email,
          message: `All sessions were revoked by ${actor.email}. Sign in again.`,
        }),
      );

      return { revoked: ids.length };
    },

    async impersonate(
      actor: StaffRecord,
      input: { userId: string; reason: string },
      ctx: RequestContext,
    ): Promise<{
      accessToken: string;
      expiresIn: number;
      user: { id: string; name: string | null; phoneMasked: string; status: string };
    }> {
      const customer = await repo.findCustomer(input.userId);

      if (!customer || customer.status === "DELETED") {
        throw AppError.notFound("Customer not found");
      }

      const accessToken = await tokens.signImpersonation({
        userId: customer.id,
        staffId: actor.id,
        staffEmail: actor.email,
        reason: input.reason,
      });

      await audit.write({
        actorType: "STAFF",
        actorId: actor.id,
        action: "staff.impersonation_started",
        entityType: "User",
        entityId: customer.id,
        reason: input.reason,
        after: { staffEmail: actor.email },
        ip: ctx.ip ?? null,
        requestId: ctx.requestId ?? null,
      });

      await repo.createSecurityEvent({
        type: "ADMIN_IMPERSONATION",
        userId: customer.id,
        ip: ctx.ip ?? null,
        userAgent: ctx.userAgent ?? null,
        result: "OK",
        meta: { staffId: actor.id, reason: input.reason },
      });

      options.onEvent?.("ADMIN_IMPERSONATION", {
        userId: customer.id,
        staffId: actor.id,
        staffEmail: actor.email,
        reason: input.reason,
      });

      await alertSuperAdmins(
        `${actor.email} started impersonating customer ${customer.id}. Reason: ${input.reason}`,
        actor.email,
      );

      return {
        accessToken,
        expiresIn: 1800,
        user: {
          id: customer.id,
          name: customer.name,
          phoneMasked: maskPhone(customer.phoneE164),
          status: customer.status,
        },
      };
    },
  };
}

import type { FastifyReply, FastifyRequest } from "fastify";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { AppError } from "../../lib/errors.js";
import { createPaginationMeta, paginationQuerySchema } from "../../lib/pagination.js";
import { permissionsFor, STAFF_ROLES } from "../../lib/permissions.js";
import { ADMIN_COOKIE } from "../../plugins/admin.js";

const staffRoleSchema = z.enum(STAFF_ROLES);
const staffStatusSchema = z.enum(["INVITED", "ACTIVE", "DISABLED"]);
const emailSchema = z.string().trim().email().max(254);
const passwordSchema = z.string().min(1).max(128);
const tokenSchema = z.string().min(1).max(512);
const codeSchema = z.string().regex(/^\d{6}$/, "must be a 6-digit code");
const recoveryCodeSchema = z.string().trim().min(5).max(32);

const staffViewSchema = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string(),
  role: staffRoleSchema,
  status: staffStatusSchema,
  mfaEnabled: z.boolean(),
  permissions: z.array(z.string()),
  lastLoginAt: z.date().nullable(),
});

const sessionViewSchema = z.object({
  id: z.string(),
  ipMasked: z.string().nullable(),
  userAgent: z.string().nullable(),
  createdAt: z.date(),
  lastSeenAt: z.date().nullable(),
  expiresAt: z.date(),
  stepUpActive: z.boolean(),
  current: z.boolean(),
});

const sessionResponseSchema = z.object({
  expiresIn: z.number().int().positive(),
  csrfToken: z.string(),
  staff: staffViewSchema,
});

const loginResponseSchema = z.object({
  requiresMfa: z.literal(true),
  mfaToken: z.string(),
  expiresIn: z.number().int().positive(),
  enrollmentRequired: z.boolean(),
});

const mfaBodySchema = z
  .object({
    mfaToken: tokenSchema,
    code: codeSchema.optional(),
    recoveryCode: recoveryCodeSchema.optional(),
  })
  .refine((value) => Boolean(value.code) !== Boolean(value.recoveryCode), {
    message: "Provide exactly one of code or recoveryCode",
  });

const stepUpBodySchema = z
  .object({
    password: passwordSchema,
    code: codeSchema.optional(),
    recoveryCode: recoveryCodeSchema.optional(),
  })
  .refine((value) => Boolean(value.code) !== Boolean(value.recoveryCode), {
    message: "Provide exactly one of code or recoveryCode",
  });

const inviteListSchema = paginationQuerySchema.extend({
  search: z.string().trim().max(100).optional(),
  role: staffRoleSchema.optional(),
  status: staffStatusSchema.optional(),
});

const updateStaffSchema = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    role: staffRoleSchema.optional(),
    status: staffStatusSchema.optional(),
  })
  .refine((value) => Object.values(value).some((entry) => entry !== undefined), {
    message: "Provide at least one field",
  });

function setSessionCookie(
  reply: FastifyReply,
  token: string,
  expiresInSec: number,
): void {
  reply.setCookie(ADMIN_COOKIE, token, {
    httpOnly: true,
    secure: true,
    sameSite: "strict",
    path: "/",
    maxAge: expiresInSec,
  });
}

function clearSessionCookie(reply: FastifyReply): void {
  reply.clearCookie(ADMIN_COOKIE, { path: "/" });
}

function staff(request: FastifyRequest) {
  if (!request.staff) {
    throw AppError.unauthorized();
  }

  return request.staff;
}

function session(request: FastifyRequest) {
  if (!request.staffSession) {
    throw AppError.unauthorized();
  }

  return request.staffSession;
}

export const adminRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook("onRequest", async (request, reply) => {
    reply.header("Cache-Control", "no-store");

    if (!app.adminIpAllowed(request.ip)) {
      throw new AppError(403, "IP_NOT_ALLOWED", "This IP address is not allowed");
    }
  });

  app.post(
    "/auth/login",
    {
      schema: {
        tags: ["Admin Auth"],
        summary: "Start staff sign-in with email and password",
        body: z.object({ email: emailSchema, password: passwordSchema }),
        response: { 200: loginResponseSchema },
      },
    },
    async (request) =>
      app.staffAuthService.login(request.body, app.adminContext(request)),
  );

  app.post(
    "/auth/mfa/verify",
    {
      schema: {
        tags: ["Admin Auth"],
        summary: "Verify a TOTP or recovery code and create a staff session",
        body: mfaBodySchema,
        response: { 200: sessionResponseSchema },
      },
    },
    async (request, reply) => {
      const result = await app.staffAuthService.verifyMfa(
        request.body,
        app.adminContext(request),
      );

      setSessionCookie(reply, result.sessionToken, result.expiresIn);

      return {
        expiresIn: result.expiresIn,
        csrfToken: result.csrfToken,
        staff: result.staff,
      };
    },
  );

  app.post(
    "/auth/mfa/enroll/start",
    {
      schema: {
        tags: ["Admin Auth"],
        summary: "Start TOTP enrollment",
        body: z.object({ mfaToken: tokenSchema }),
        response: {
          200: z.object({
            secret: z.string(),
            otpauthUri: z.string(),
            expiresIn: z.number().int().positive(),
          }),
        },
      },
    },
    async (request) =>
      app.staffAuthService.startEnrollment(
        request.body,
        app.adminContext(request),
      ),
  );

  app.post(
    "/auth/mfa/enroll/confirm",
    {
      schema: {
        tags: ["Admin Auth"],
        summary: "Confirm TOTP enrollment and create a staff session",
        body: z.object({ mfaToken: tokenSchema, code: codeSchema }),
        response: {
          200: sessionResponseSchema.extend({
            recoveryCodes: z.array(z.string()),
          }),
        },
      },
    },
    async (request, reply) => {
      const result = await app.staffAuthService.confirmEnrollment(
        request.body,
        app.adminContext(request),
      );

      setSessionCookie(reply, result.sessionToken, result.expiresIn);

      return {
        expiresIn: result.expiresIn,
        csrfToken: result.csrfToken,
        staff: result.staff,
        recoveryCodes: result.recoveryCodes,
      };
    },
  );

  app.get(
    "/auth/invites/:token",
    {
      schema: {
        tags: ["Admin Auth"],
        summary: "Inspect a staff invitation",
        params: z.object({ token: tokenSchema }),
        response: {
          200: z.object({
            data: z.object({
              email: z.string(),
              role: staffRoleSchema,
              expiresAt: z.date(),
            }),
          }),
        },
      },
    },
    async (request) => ({
      data: await app.staffAuthService.inviteInfo(request.params.token),
    }),
  );

  app.post(
    "/auth/invites/accept",
    {
      schema: {
        tags: ["Admin Auth"],
        summary: "Accept a staff invitation and set a password",
        body: z.object({
          token: tokenSchema,
          password: passwordSchema,
          name: z.string().trim().min(1).max(100).optional(),
        }),
        response: {
          200: z.object({
            email: z.string(),
            enrollmentRequired: z.literal(true),
          }),
        },
      },
    },
    async (request) =>
      app.staffAuthService.acceptInvite(request.body, app.adminContext(request)),
  );

  app.post(
    "/auth/password/forgot",
    {
      schema: {
        tags: ["Admin Auth"],
        summary: "Request a staff password reset email",
        body: z.object({ email: emailSchema }),
        response: { 202: z.object({ status: z.literal("EMAIL_SENT") }) },
      },
    },
    async (request, reply) => {
      await app.staffAuthService.forgotPassword(
        request.body,
        app.adminContext(request),
      );

      return reply.code(202).send({ status: "EMAIL_SENT" as const });
    },
  );

  app.post(
    "/auth/password/reset",
    {
      schema: {
        tags: ["Admin Auth"],
        summary: "Reset a staff password with a reset token",
        body: z.object({ token: tokenSchema, newPassword: passwordSchema }),
        response: { 204: z.null() },
      },
    },
    async (request, reply) => {
      await app.staffAuthService.resetPassword(
        request.body,
        app.adminContext(request),
      );

      return reply.code(204).send(null);
    },
  );

  app.post(
    "/auth/step-up",
    {
      preHandler: [app.requireStaff],
      schema: {
        tags: ["Admin Auth"],
        summary: "Elevate the current session for sensitive actions",
        security: [{ cookieAuth: [] }],
        body: stepUpBodySchema,
        response: {
          200: z.object({
            stepUpUntil: z.date(),
            expiresIn: z.number().int().positive(),
          }),
        },
      },
    },
    async (request) => {
      const current = staff(request);

      return app.staffAuthService.stepUp(
        {
          staffId: current.id,
          sessionId: session(request).id,
          password: request.body.password,
          ...(request.body.code ? { code: request.body.code } : {}),
          ...(request.body.recoveryCode
            ? { recoveryCode: request.body.recoveryCode }
            : {}),
        },
        app.adminContext(request),
      );
    },
  );

  app.post(
    "/auth/logout",
    {
      preHandler: [app.requireStaff],
      schema: {
        tags: ["Admin Auth"],
        summary: "Revoke the current staff session",
        security: [{ cookieAuth: [] }],
        response: { 204: z.null() },
      },
    },
    async (request, reply) => {
      const current = staff(request);
      const currentSession = session(request);
      await app.staffAuthService.logout(
        current.id,
        currentSession.id,
        app.adminContext(request),
      );
      clearSessionCookie(reply);

      return reply.code(204).send(null);
    },
  );

  app.post(
    "/auth/logout-all",
    {
      preHandler: [app.requireStaff],
      schema: {
        tags: ["Admin Auth"],
        summary: "Revoke every staff session",
        security: [{ cookieAuth: [] }],
        response: { 204: z.null() },
      },
    },
    async (request, reply) => {
      await app.staffAuthService.logoutAll(
        staff(request).id,
        app.adminContext(request),
      );
      clearSessionCookie(reply);

      return reply.code(204).send(null);
    },
  );

  app.get(
    "/auth/sessions",
    {
      preHandler: [app.requireStaff],
      schema: {
        tags: ["Admin Auth"],
        summary: "List active staff sessions",
        security: [{ cookieAuth: [] }],
        response: { 200: z.object({ data: z.array(sessionViewSchema) }) },
      },
    },
    async (request) => ({
      data: await app.staffAuthService.listSessions(
        staff(request).id,
        session(request).id,
      ),
    }),
  );

  app.delete(
    "/auth/sessions/:id",
    {
      preHandler: [app.requireStaff],
      schema: {
        tags: ["Admin Auth"],
        summary: "Revoke one staff session",
        security: [{ cookieAuth: [] }],
        params: z.object({ id: z.string().min(1) }),
        response: { 204: z.null() },
      },
    },
    async (request, reply) => {
      await app.staffAuthService.revokeSession(
        staff(request).id,
        request.params.id,
        app.adminContext(request),
      );

      return reply.code(204).send(null);
    },
  );

  app.get(
    "/auth/me",
    {
      preHandler: [app.requireStaff],
      schema: {
        tags: ["Admin Auth"],
        summary: "Get the authenticated staff member",
        security: [{ cookieAuth: [] }],
        response: { 200: z.object({ data: staffViewSchema }) },
      },
    },
    async (request) => ({
      data: await app.staffAuthService.me(staff(request).id),
    }),
  );

  app.post(
    "/auth/password/change",
    {
      preHandler: [app.requireStaff],
      schema: {
        tags: ["Admin Auth"],
        summary: "Change the current staff password",
        security: [{ cookieAuth: [] }],
        body: z.object({
          currentPassword: passwordSchema,
          newPassword: passwordSchema,
        }),
        response: { 204: z.null() },
      },
    },
    async (request, reply) => {
      const current = staff(request);
      await app.staffAuthService.changePassword(
        {
          staffId: current.id,
          sessionId: session(request).id,
          currentPassword: request.body.currentPassword,
          newPassword: request.body.newPassword,
        },
        app.adminContext(request),
      );

      return reply.code(204).send(null);
    },
  );

  app.post(
    "/auth/mfa/recovery-codes/regenerate",
    {
      preHandler: [app.requireStaff, app.requireStepUp],
      schema: {
        tags: ["Admin Auth"],
        summary: "Regenerate single-use recovery codes",
        security: [{ cookieAuth: [] }],
        response: {
          200: z.object({
            recoveryCodes: z.array(z.string()),
            remaining: z.number().int().positive(),
          }),
        },
      },
    },
    async (request) =>
      app.staffAuthService.regenerateRecoveryCodes(
        staff(request).id,
        app.adminContext(request),
      ),
  );

  app.post(
    "/staff/invite",
    {
      preHandler: [
        app.requireStaff,
        app.requirePermission("staff:manage"),
        app.requireStepUp,
      ],
      schema: {
        tags: ["Admin Staff"],
        summary: "Invite a staff member",
        security: [{ cookieAuth: [] }],
        body: z.object({
          email: emailSchema,
          name: z.string().trim().min(1).max(100).optional(),
          role: staffRoleSchema,
        }),
        response: {
          200: z.object({
            data: z.object({
              id: z.string(),
              email: z.string(),
              role: staffRoleSchema,
              expiresAt: z.date(),
              devInviteUrl: z.string().optional(),
            }),
          }),
        },
      },
    },
    async (request) => ({
      data: await app.staffManagementService.createInvite(
        staff(request),
        request.body,
        app.adminContext(request),
      ),
    }),
  );

  app.get(
    "/staff",
    {
      preHandler: [app.requireStaff, app.requirePermission("staff:manage")],
      schema: {
        tags: ["Admin Staff"],
        summary: "List staff members",
        security: [{ cookieAuth: [] }],
        querystring: inviteListSchema,
        response: {
          200: z.object({
            data: z.array(staffViewSchema),
            meta: z.object({
              page: z.number().int(),
              limit: z.number().int(),
              total: z.number().int(),
              totalPages: z.number().int(),
            }),
          }),
        },
      },
    },
    async (request) => {
      const { page, limit, ...filters } = request.query;
      const result = await app.staffManagementService.listStaff({
        page,
        limit,
        ...filters,
      });

      return {
        data: result.rows.map((row) => ({
          id: row.id,
          email: row.email,
          name: row.name,
          role: row.role,
          status: row.status,
          mfaEnabled: row.mfaEnabledAt !== null,
          permissions: [...permissionsFor(row.role)],
          lastLoginAt: row.lastLoginAt,
        })),
        meta: createPaginationMeta(result.total, page, limit),
      };
    },
  );

  app.patch(
    "/staff/:id",
    {
      preHandler: [
        app.requireStaff,
        app.requirePermission("staff:manage"),
        app.requireStepUp,
      ],
      schema: {
        tags: ["Admin Staff"],
        summary: "Update a staff member",
        security: [{ cookieAuth: [] }],
        params: z.object({ id: z.string().min(1) }),
        body: updateStaffSchema,
        response: { 200: z.object({ data: staffViewSchema }) },
      },
    },
    async (request) => ({
      data: await app.staffManagementService.updateStaff(
        staff(request),
        request.params.id,
        request.body,
        app.adminContext(request),
      ),
    }),
  );

  app.post(
    "/staff/:id/reset-mfa",
    {
      preHandler: [
        app.requireStaff,
        app.requirePermission("staff:manage"),
        app.requireStepUp,
      ],
      schema: {
        tags: ["Admin Staff"],
        summary: "Reset a staff member's MFA",
        security: [{ cookieAuth: [] }],
        params: z.object({ id: z.string().min(1) }),
        response: { 204: z.null() },
      },
    },
    async (request, reply) => {
      await app.staffManagementService.resetMfa(
        staff(request),
        request.params.id,
        app.adminContext(request),
      );

      return reply.code(204).send(null);
    },
  );

  app.post(
    "/staff/:id/revoke-sessions",
    {
      preHandler: [
        app.requireStaff,
        app.requirePermission("staff:manage"),
        app.requireStepUp,
      ],
      schema: {
        tags: ["Admin Staff"],
        summary: "Revoke all sessions for a staff member",
        security: [{ cookieAuth: [] }],
        params: z.object({ id: z.string().min(1) }),
        response: { 200: z.object({ revoked: z.number().int() }) },
      },
    },
    async (request) =>
      app.staffManagementService.revokeSessions(
        staff(request),
        request.params.id,
        app.adminContext(request),
      ),
  );

  app.post(
    "/impersonation",
    {
      preHandler: [
        app.requireStaff,
        app.requirePermission("impersonate"),
        app.requireStepUp,
      ],
      schema: {
        tags: ["Admin Staff"],
        summary: "Issue a read-only customer impersonation token",
        security: [{ cookieAuth: [] }],
        body: z.object({
          userId: z.string().min(1),
          reason: z.string().trim().min(10).max(500),
        }),
        response: {
          200: z.object({
            accessToken: z.string(),
            expiresIn: z.number().int().positive(),
            user: z.object({
              id: z.string(),
              name: z.string().nullable(),
              phoneMasked: z.string(),
              status: z.string(),
            }),
          }),
        },
      },
    },
    async (request) =>
      app.staffManagementService.impersonate(
        staff(request),
        request.body,
        app.adminContext(request),
      ),
  );
};

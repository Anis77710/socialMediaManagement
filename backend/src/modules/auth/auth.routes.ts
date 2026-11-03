import type { FastifyReply, FastifyRequest } from "fastify";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { env } from "../../config/env.js";
import { AppError } from "../../lib/errors.js";
import type { RequestContext } from "./auth.types.js";
import {
  authUserSchema,
  challengeResponseSchema,
  configResponseSchema,
  googleLinkSchema,
  googleLoginSchema,
  googleResponseSchema,
  phoneChangeConfirmSchema,
  phoneChangeRequestSchema,
  refreshBodySchema,
  refreshResponseSchema,
  requestOtpSchema,
  sessionResponseSchema,
  sessionViewSchema,
  updateMeSchema,
  verifyOtpSchema,
} from "./auth.schemas.js";

const REFRESH_COOKIE = "__Host-rf_refresh";
const cookieMaxAgeSec = env.REFRESH_SLIDING_DAYS * 86_400;

function context(request: FastifyRequest): RequestContext {
  const userAgent = request.headers["user-agent"];

  return {
    ...(request.ip ? { ip: request.ip } : {}),
    ...(typeof userAgent === "string" ? { userAgent } : {}),
  };
}

function isMobile(request: FastifyRequest): boolean {
  return request.headers["x-client"] === "mobile";
}

function setRefreshCookie(reply: FastifyReply, token: string): void {
  reply.setCookie(REFRESH_COOKIE, token, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: cookieMaxAgeSec,
  });
}

function clearRefreshCookie(reply: FastifyReply): void {
  reply.clearCookie(REFRESH_COOKIE, { path: "/" });
}

function assertWebOrigin(request: FastifyRequest): void {
  const origin = request.headers.origin;
  const requestedWith = request.headers["x-requested-with"];

  if (!origin || !env.CORS_ORIGINS.includes(origin)) {
    throw new AppError(403, "AUTH_ORIGIN_NOT_ALLOWED", "Origin is not allowed");
  }

  if (!requestedWith) {
    throw new AppError(403, "AUTH_REQUESTED_WITH_REQUIRED", "Missing X-Requested-With header");
  }
}

function currentAuth(request: FastifyRequest): { userId: string; sessionId: string } {
  if (!request.auth) {
    throw new AppError(401, "UNAUTHORIZED", "Authentication required");
  }

  return request.auth;
}

function sessionBody(
  request: FastifyRequest,
  result: {
    accessToken: string;
    refreshToken: string;
    expiresIn: number;
    user: z.infer<typeof authUserSchema>;
    isNewUser: boolean;
    deletionPending: boolean;
  },
) {
  return {
    accessToken: result.accessToken,
    expiresIn: result.expiresIn,
    user: result.user,
    isNewUser: result.isNewUser,
    deletionPending: result.deletionPending,
    ...(isMobile(request) ? { refreshToken: result.refreshToken } : {}),
  };
}

export const authRoutes: FastifyPluginAsyncZod = async (app) => {
  app.post(
    "/otp/request",
    {
      schema: {
        tags: ["App Auth"],
        summary: "Request an SMS OTP",
        body: requestOtpSchema,
        response: { 202: challengeResponseSchema },
      },
    },
    async (request, reply) => {
      let result;

      if (request.headers.authorization) {
        const identity = await app.verifyGoogleAttach(request);
        result = await app.authService.requestGoogleAttachOtp(request.body, context(request));
        request.log.debug({ sub: identity.sub }, "Google attach OTP requested");
      } else {
        result = await app.authService.requestOtp(request.body, context(request));
      }

      return reply.code(202).send(result);
    },
  );

  app.post(
    "/otp/verify",
    {
      schema: {
        tags: ["App Auth"],
        summary: "Verify an SMS OTP and sign in",
        body: verifyOtpSchema,
        response: { 200: sessionResponseSchema },
      },
    },
    async (request, reply) => {
      const identity = request.headers.authorization
        ? await app.verifyGoogleAttach(request)
        : undefined;
      const result = await app.authService.verifyOtp(
        request.body,
        context(request),
        identity,
      );

      if (!isMobile(request)) {
        setRefreshCookie(reply, result.refreshToken);
      }

      return sessionBody(request, result);
    },
  );

  app.post(
    "/google",
    {
      schema: {
        tags: ["App Auth"],
        summary: "Sign in with Google or obtain a phone-attach token",
        body: googleLoginSchema,
        response: { 200: googleResponseSchema },
      },
    },
    async (request, reply) => {
      const result = await app.authService.googleLogin(request.body, context(request));

      if (result.needsPhone) {
        return result;
      }

      if (!isMobile(request)) {
        setRefreshCookie(reply, result.refreshToken);
      }

      return sessionBody(request, result);
    },
  );

  app.post(
    "/refresh",
    {
      schema: {
        tags: ["App Auth"],
        summary: "Rotate the refresh token",
        body: refreshBodySchema,
        response: { 200: refreshResponseSchema },
      },
    },
    async (request, reply) => {
      const mobile = isMobile(request);
      const bodyToken = request.body?.refreshToken;
      const token = mobile ? bodyToken : request.cookies[REFRESH_COOKIE];

      if (!mobile) {
        assertWebOrigin(request);
      }

      if (!token) {
        throw new AppError(401, "AUTH_INVALID_REFRESH", "Invalid refresh token");
      }

      const result = await app.authService.refresh({ refreshToken: token }, context(request));

      if (mobile) {
        return result;
      }

      setRefreshCookie(reply, result.refreshToken);

      return {
        accessToken: result.accessToken,
        expiresIn: result.expiresIn,
      };
    },
  );

  app.post(
    "/logout",
    {
      preHandler: [app.requireAuth],
      schema: {
        tags: ["App Auth"],
        summary: "Revoke the current session",
        security: [{ bearerAuth: [] }],
        response: { 204: z.null() },
      },
    },
    async (request, reply) => {
      const auth = currentAuth(request);
      await app.authService.logout(auth.userId, auth.sessionId, context(request));
      clearRefreshCookie(reply);

      return reply.code(204).send(null);
    },
  );

  app.post(
    "/logout-all",
    {
      preHandler: [app.requireAuth],
      schema: {
        tags: ["App Auth"],
        summary: "Revoke every session and invalidate all access tokens",
        security: [{ bearerAuth: [] }],
        response: { 204: z.null() },
      },
    },
    async (request, reply) => {
      const auth = currentAuth(request);
      await app.authService.logoutAll(auth.userId, context(request));
      clearRefreshCookie(reply);

      return reply.code(204).send(null);
    },
  );

  app.get(
    "/sessions",
    {
      preHandler: [app.requireAuth],
      schema: {
        tags: ["App Auth"],
        summary: "List active devices",
        security: [{ bearerAuth: [] }],
        response: { 200: z.object({ data: z.array(sessionViewSchema) }) },
      },
    },
    async (request) => {
      const auth = currentAuth(request);
      const sessions = await app.authService.listSessions(auth.userId, auth.sessionId);

      return { data: sessions };
    },
  );

  app.delete(
    "/sessions/:id",
    {
      preHandler: [app.requireAuth],
      schema: {
        tags: ["App Auth"],
        summary: "Revoke one device session",
        security: [{ bearerAuth: [] }],
        params: z.object({ id: z.string().min(1) }),
        response: { 204: z.null() },
      },
    },
    async (request, reply) => {
      const auth = currentAuth(request);
      await app.authService.revokeSession(auth.userId, request.params.id, context(request));

      return reply.code(204).send(null);
    },
  );

  app.get(
    "/me",
    {
      preHandler: [app.requireAuth],
      schema: {
        tags: ["App Auth"],
        summary: "Get the authenticated customer",
        security: [{ bearerAuth: [] }],
        response: { 200: z.object({ data: authUserSchema }) },
      },
    },
    async (request) => {
      const auth = currentAuth(request);
      const user = await app.authService.getMe(auth.userId);

      return { data: user };
    },
  );

  app.patch(
    "/me",
    {
      preHandler: [app.requireAuth],
      schema: {
        tags: ["App Auth"],
        summary: "Update name or locale",
        security: [{ bearerAuth: [] }],
        body: updateMeSchema,
        response: { 200: z.object({ data: authUserSchema }) },
      },
    },
    async (request) => {
      const auth = currentAuth(request);
      const user = await app.authService.updateMe(auth.userId, request.body);

      return { data: user };
    },
  );

  app.post(
    "/phone-change/request",
    {
      preHandler: [app.requireAuth],
      schema: {
        tags: ["App Auth"],
        summary: "Request an OTP for a new phone number",
        security: [{ bearerAuth: [] }],
        body: phoneChangeRequestSchema,
        response: { 202: challengeResponseSchema },
      },
    },
    async (request, reply) => {
      const auth = currentAuth(request);
      const result = await app.authService.requestPhoneChange(
        auth.userId,
        request.body,
        context(request),
      );

      return reply.code(202).send(result);
    },
  );

  app.post(
    "/phone-change/confirm",
    {
      preHandler: [app.requireAuth],
      schema: {
        tags: ["App Auth"],
        summary: "Confirm the new phone number",
        security: [{ bearerAuth: [] }],
        body: phoneChangeConfirmSchema,
        response: { 204: z.null() },
      },
    },
    async (request, reply) => {
      const auth = currentAuth(request);
      await app.authService.confirmPhoneChange(
        auth.userId,
        auth.sessionId,
        request.body,
        context(request),
      );

      return reply.code(204).send(null);
    },
  );

  app.post(
    "/google/link",
    {
      preHandler: [app.requireAuth],
      schema: {
        tags: ["App Auth"],
        summary: "Link a Google account to the current customer",
        security: [{ bearerAuth: [] }],
        body: googleLinkSchema,
        response: { 200: z.object({ data: authUserSchema }) },
      },
    },
    async (request) => {
      const auth = currentAuth(request);
      const user = await app.authService.linkGoogle(auth.userId, request.body, context(request));

      return { data: user };
    },
  );

  app.delete(
    "/google/link",
    {
      preHandler: [app.requireAuth],
      schema: {
        tags: ["App Auth"],
        summary: "Unlink Google from the current customer",
        security: [{ bearerAuth: [] }],
        response: { 204: z.null() },
      },
    },
    async (request, reply) => {
      const auth = currentAuth(request);
      await app.authService.unlinkGoogle(auth.userId, context(request));

      return reply.code(204).send(null);
    },
  );

  app.post(
    "/account/delete",
    {
      preHandler: [app.requireAuth],
      schema: {
        tags: ["App Auth"],
        summary: "Request account deletion",
        security: [{ bearerAuth: [] }],
        response: { 202: z.object({ status: z.literal("DELETION_PENDING") }) },
      },
    },
    async (request, reply) => {
      const auth = currentAuth(request);
      await app.authService.requestAccountDeletion(auth.userId, context(request));

      return reply.code(202).send({ status: "DELETION_PENDING" });
    },
  );

  app.post(
    "/account/delete/cancel",
    {
      preHandler: [app.requireAuth],
      schema: {
        tags: ["App Auth"],
        summary: "Cancel a pending account deletion",
        security: [{ bearerAuth: [] }],
        response: { 200: z.object({ status: z.literal("ACTIVE") }) },
      },
    },
    async (request) => {
      const auth = currentAuth(request);
      await app.authService.cancelAccountDeletion(auth.userId, context(request));

      return { status: "ACTIVE" as const };
    },
  );
};

export const publicAuthRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    "/config",
    {
      schema: {
        tags: ["App Auth"],
        summary: "Public auth configuration",
        response: { 200: configResponseSchema },
      },
    },
    async () => app.authService.publicConfig(),
  );
};

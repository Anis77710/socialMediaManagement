import type { Redis } from "ioredis";
import type { PrismaClient } from "../generated/prisma/client.js";
import type { AuthService } from "../modules/auth/auth.service.js";
import type { ImpersonationClaims, RestrictedClaims } from "../lib/tokens.js";
import type { Permission } from "../lib/permissions.js";
import type { StaffAuthService } from "../modules/staff/staff-auth.service.js";
import type { StaffManagementService } from "../modules/staff/staff-management.service.js";
import type {
  RequestContext,
  StaffRecord,
  StaffSessionRecord,
} from "../modules/staff/staff.types.js";

declare module "fastify" {
  interface FastifyInstance {
    prisma: PrismaClient;
    redis: Redis;
    authService: AuthService;
    requireAuth: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    verifyGoogleAttach: (request: FastifyRequest) => Promise<RestrictedClaims>;
    staffAuthService: StaffAuthService;
    staffManagementService: StaffManagementService;
    requireStaff: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    requireStepUp: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    requirePermission: (
      permission: Permission,
    ) => (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    adminIpAllowed: (ip: string | undefined) => boolean;
    adminContext: (request: FastifyRequest) => RequestContext;
    invalidateAdminSessions: (sessionIds: string[]) => Promise<void>;
  }

  interface FastifyRequest {
    auth: { userId: string; sessionId: string; scopes: string[] } | null;
    user: { sub: string };
    googleIdentity: RestrictedClaims | null;
    impersonation: ImpersonationClaims | null;
    staff: StaffRecord | null;
    staffSession: StaffSessionRecord | null;
  }
}

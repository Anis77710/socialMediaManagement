import type { PrismaClient } from "../../generated/prisma/client.js";
import { AppError } from "../../lib/errors.js";
import type { AssetService } from "../assets/asset.service.js";

export type SupportService = ReturnType<typeof createSupportService>;

export function createSupportService(deps: {
  prisma: PrismaClient;
  assets: AssetService;
  now?: () => Date;
}) {
  const now = deps.now ?? (() => new Date());

  async function createTicket(input: {
    businessId: string;
    userId: string;
    subject: string;
    body: string;
    priority?: string;
  }) {
    return deps.prisma.supportTicket.create({
      data: {
        businessId: input.businessId,
        subject: input.subject,
        priority: input.priority ?? "NORMAL",
        messages: {
          create: {
            authorType: "CUSTOMER",
            authorId: input.userId,
            body: input.body,
          },
        },
      },
      include: { messages: true },
    });
  }

  async function listTickets(businessId: string) {
    return deps.prisma.supportTicket.findMany({
      where: { businessId },
      include: { messages: { orderBy: { createdAt: "desc" }, take: 1 } },
      orderBy: { updatedAt: "desc" },
      take: 50,
    });
  }

  async function getTicket(businessId: string, ticketId: string) {
    const ticket = await deps.prisma.supportTicket.findFirst({
      where: { id: ticketId, businessId },
      include: { messages: { orderBy: { createdAt: "asc" } } },
    });

    if (!ticket) {
      throw AppError.notFound("Support ticket not found");
    }

    return ticket;
  }

  async function addMessage(input: {
    businessId: string;
    ticketId: string;
    userId: string;
    body: string;
  }) {
    await getTicket(input.businessId, input.ticketId);

    return deps.prisma.$transaction(async (tx) => {
      const message = await tx.ticketMessage.create({
        data: {
          ticketId: input.ticketId,
          authorType: "CUSTOMER",
          authorId: input.userId,
          body: input.body,
        },
      });
      await tx.supportTicket.update({
        where: { id: input.ticketId },
        data: { status: "OPEN", updatedAt: now() },
      });

      return message;
    });
  }

  async function createDataRequest(input: {
    userId: string;
    kind: "EXPORT" | "DELETION";
  }) {
    const existing = await deps.prisma.dataRequest.findFirst({
      where: {
        userId: input.userId,
        kind: input.kind,
        status: { in: ["PENDING", "PROCESSING"] },
      },
    });

    if (existing) {
      return existing;
    }

    const request = await deps.prisma.dataRequest.create({
      data: {
        userId: input.userId,
        kind: input.kind,
        dueAt: new Date(now().getTime() + 30 * 86_400_000),
      },
    });

    if (input.kind === "DELETION") {
      await deps.prisma.$transaction([
        deps.prisma.user.update({
          where: { id: input.userId },
          data: { deletionRequestedAt: now(), status: "DELETION_PENDING" },
        }),
        deps.prisma.session.updateMany({
          where: { userId: input.userId, revokedAt: null },
          data: { revokedAt: now(), revokeReason: "ACCOUNT_DELETION_REQUESTED" },
        }),
      ]);
    }

    return request;
  }

  async function listDataRequests(userId: string) {
    return deps.prisma.dataRequest.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
    });
  }

  async function exportData(userId: string) {
    const [user, businesses, posts, sales, payments, invoices] = await Promise.all([
      deps.prisma.user.findUnique({
        where: { id: userId },
        select: {
          id: true,
          phoneE164: true,
          email: true,
          name: true,
          locale: true,
          createdAt: true,
        },
      }),
      deps.prisma.business.findMany({ where: { ownerId: userId } }),
      deps.prisma.post.findMany({
        where: { business: { ownerId: userId } },
        select: { id: true, title: true, caption: true, status: true, createdAt: true },
      }),
      deps.prisma.salesRecord.findMany({ where: { business: { ownerId: userId } } }),
      deps.prisma.payment.findMany({
        where: { business: { ownerId: userId } },
        select: { id: true, amountPaisa: true, status: true, createdAt: true },
      }),
      deps.prisma.invoice.findMany({
        where: { business: { ownerId: userId } },
        select: { id: true, number: true, totalPaisa: true, issuedAt: true },
      }),
    ]);

    if (!user) {
      throw AppError.notFound("User not found");
    }

    return {
      exportedAt: now(),
      user,
      businesses,
      posts,
      sales,
      payments,
      invoices,
    };
  }

  async function attachExport(userId: string, requestId: string, assetId: string) {
    const request = await deps.prisma.dataRequest.findFirst({
      where: { id: requestId, userId },
    });

    if (!request) {
      throw AppError.notFound("Data request not found");
    }

    return deps.prisma.dataRequest.update({
      where: { id: request.id },
      data: { status: "COMPLETED", completedAt: now(), assetId },
    });
  }

  return {
    createTicket,
    listTickets,
    getTicket,
    addMessage,
    createDataRequest,
    listDataRequests,
    exportData,
    attachExport,
  };
}

import { randomUUID } from "node:crypto";
import type {
  PayProvider,
  Prisma,
  PrismaClient,
  Subscription,
} from "../../generated/prisma/client.js";
import { AppError } from "../../lib/errors.js";
import { fiscalYear, formatBsFull } from "../../lib/nepali.js";
import { formatNpr, vatFromNet, vatIncludedInGross } from "../../lib/money.js";
import type { PaymentProviders, ConfirmResult, PaymentIntent } from "../../providers/payments/index.js";
import type { AssetService } from "../assets/asset.service.js";
import type { NotificationService } from "../notifications/notification.service.js";
import type { QuotaService } from "../billing/quota.service.js";
import type { Renderer } from "../../providers/renderer/types.js";

export type BillingService = ReturnType<typeof createBillingService>;

function planLimits(plan: {
  postsPerPeriod: number;
  reelsPerPeriod: number;
  maxAccounts: number;
  features: Prisma.JsonValue;
}) {
  return {
    posts: plan.postsPerPeriod,
    reels: plan.reelsPerPeriod,
    accounts: plan.maxAccounts,
    features: plan.features,
  };
}

export function createBillingService(deps: {
  prisma: PrismaClient;
  providers: PaymentProviders;
  quota: QuotaService;
  assets: AssetService;
  renderer: Renderer;
  notifications: NotificationService;
  env: {
    PUBLIC_API_URL: string;
    APP_WEB_URL: string;
    VAT_RATE_BP: number;
    VAT_INCLUSIVE: boolean;
    GRACE_DAYS: number;
  };
  now?: () => Date;
}) {
  const now = deps.now ?? (() => new Date());

  function taxBreakdown(planPricePaisa: number) {
    if (deps.env.VAT_INCLUSIVE) {
      const vatPaisa = vatIncludedInGross(planPricePaisa, deps.env.VAT_RATE_BP);

      return {
        subtotalPaisa: planPricePaisa - vatPaisa,
        vatPaisa,
        totalPaisa: planPricePaisa,
      };
    }

    const vatPaisa = vatFromNet(planPricePaisa, deps.env.VAT_RATE_BP);

    return {
      subtotalPaisa: planPricePaisa,
      vatPaisa,
      totalPaisa: planPricePaisa + vatPaisa,
    };
  }

  async function plans() {
    return deps.prisma.plan.findMany({
      where: { active: true },
      orderBy: { sortOrder: "asc" },
    });
  }

  async function subscriptionFor(businessId: string) {
    return deps.prisma.subscription.findUnique({
      where: { businessId },
      include: { plan: true, pendingPlan: true },
    });
  }

  async function upgradeQuote(businessId: string, planId: string) {
    const [plan, subscription] = await Promise.all([
      deps.prisma.plan.findUnique({ where: { id: planId } }),
      subscriptionFor(businessId),
    ]);

    if (!plan || !plan.active) {
      throw AppError.notFound("Plan not found");
    }

    if (!subscription) {
      throw new AppError(409, "SUBSCRIPTION_REQUIRED", "Create a business profile first");
    }

    const breakdown = taxBreakdown(plan.pricePaisa);

    return {
      currentPlan: subscription.plan,
      targetPlan: plan,
      direction:
        plan.pricePaisa > subscription.plan.pricePaisa
          ? "UPGRADE"
          : plan.pricePaisa < subscription.plan.pricePaisa
            ? "DOWNGRADE"
            : "SAME",
      amountPaisa: breakdown.totalPaisa,
      subtotalPaisa: breakdown.subtotalPaisa,
      vatPaisa: breakdown.vatPaisa,
      vatRateBp: deps.env.VAT_RATE_BP,
      currency: "NPR",
      changeEffective:
        plan.pricePaisa < subscription.plan.pricePaisa ? "NEXT_PERIOD" : "IMMEDIATELY",
    };
  }

  async function initiatePayment(input: {
    businessId: string;
    planId: string;
    provider: "ESEWA" | "KHALTI";
    customer?: PaymentIntent["customer"];
  }) {
    const plan = await deps.prisma.plan.findUnique({ where: { id: input.planId } });

    if (!plan || !plan.active) {
      throw AppError.notFound("Plan not found");
    }

    const subscription = await subscriptionFor(input.businessId);

    if (!subscription) {
      throw new AppError(409, "SUBSCRIPTION_REQUIRED", "Create a business profile first");
    }

    if (subscription.planId === plan.id && subscription.status === "ACTIVE") {
      throw new AppError(409, "PLAN_ALREADY_ACTIVE", "This plan is already active");
    }

    const breakdown = taxBreakdown(plan.pricePaisa);
    const purchaseOrderId = `RF-${Date.now()}-${randomUUID().slice(0, 8)}`;
    const payment = await deps.prisma.payment.create({
      data: {
        businessId: input.businessId,
        subscriptionId: subscription.id,
        planId: plan.id,
        kind: "SUBSCRIPTION",
        provider: input.provider,
        status: "INITIATED",
        amountPaisa: breakdown.totalPaisa,
        taxPaisa: breakdown.vatPaisa,
        purchaseOrderId,
        expiresAt: new Date(now().getTime() + 30 * 60_000),
      },
    });
    const returnBase = `${deps.env.PUBLIC_API_URL.replace(/\/$/, "")}/v1/public/payments/${input.provider.toLowerCase()}/callback`;
    const intent: PaymentIntent = {
      paymentId: payment.id,
      purchaseOrderId,
      amountPaisa: breakdown.totalPaisa,
      taxPaisa: breakdown.vatPaisa,
      planName: plan.name,
      returnUrl: returnBase,
      successUrl: `${returnBase}?status=success`,
      failureUrl: `${returnBase}?status=failure`,
      ...(input.customer ? { customer: input.customer } : {}),
    };
    const provider =
      input.provider === "ESEWA" ? deps.providers.esewa : deps.providers.khalti;
    const initiated = await provider.initiate(intent);

    return {
      paymentId: payment.id,
      purchaseOrderId,
      amountPaisa: breakdown.totalPaisa,
      expiresAt: payment.expiresAt,
      ...initiated,
    };
  }

  async function initiateBankTransfer(input: { businessId: string; planId: string }) {
    const plan = await deps.prisma.plan.findUnique({ where: { id: input.planId } });

    if (!plan || !plan.active) {
      throw AppError.notFound("Plan not found");
    }

    const subscription = await subscriptionFor(input.businessId);

    if (!subscription) {
      throw new AppError(409, "SUBSCRIPTION_REQUIRED", "Create a business profile first");
    }

    const breakdown = taxBreakdown(plan.pricePaisa);
    const payment = await deps.prisma.payment.create({
      data: {
        businessId: input.businessId,
        subscriptionId: subscription.id,
        planId: plan.id,
        kind: "SUBSCRIPTION",
        provider: "BANK_TRANSFER",
        status: "PENDING",
        amountPaisa: breakdown.totalPaisa,
        taxPaisa: breakdown.vatPaisa,
        purchaseOrderId: `BT-${Date.now()}-${randomUUID().slice(0, 8)}`,
        expiresAt: new Date(now().getTime() + 7 * 86_400_000),
      },
    });

    return {
      paymentId: payment.id,
      purchaseOrderId: payment.purchaseOrderId,
      amountPaisa: breakdown.totalPaisa,
      instructions: [
        "Deposit the exact amount to Redflie's bank account.",
        "Include the purchase order id in the deposit reference.",
        "Upload the bank voucher for finance review.",
      ],
      bank: {
        name: "Nabil Bank",
        accountName: "Redflie Technologies Pvt. Ltd.",
        accountNumber: "0000000000000",
        branch: "Kathmandu",
      },
    };
  }

  async function submitBankProof(input: {
    businessId: string;
    paymentId: string;
    assetId: string;
    bankName: string;
    referenceNo: string;
    paidAt: Date;
  }) {
    const payment = await deps.prisma.payment.findFirst({
      where: { id: input.paymentId, businessId: input.businessId },
    });

    if (!payment || payment.provider !== "BANK_TRANSFER") {
      throw AppError.notFound("Bank transfer payment not found");
    }

    if (payment.status === "COMPLETED") {
      throw new AppError(409, "PAYMENT_ALREADY_COMPLETED", "This payment is already completed");
    }

    await deps.assets.get(input.businessId, input.assetId);
    const proof = await deps.prisma.bankTransferProof.upsert({
      where: { paymentId: payment.id },
      create: {
        paymentId: payment.id,
        assetId: input.assetId,
        bankName: input.bankName,
        referenceNo: input.referenceNo,
        paidAt: input.paidAt,
      },
      update: {
        assetId: input.assetId,
        bankName: input.bankName,
        referenceNo: input.referenceNo,
        paidAt: input.paidAt,
        status: "PENDING",
        reviewedAt: null,
        reviewedById: null,
        reviewNote: null,
      },
    });

    await deps.prisma.payment.update({
      where: { id: payment.id },
      data: { status: "PENDING" },
    });

    return proof;
  }

  async function handleCallback(providerId: "ESEWA" | "KHALTI", query: Record<string, string>) {
    const purchaseOrderId =
      query.transaction_uuid ??
      query.purchase_order_id ??
      query.purchaseOrderId ??
      (query.data
        ? (() => {
            try {
              const decoded = JSON.parse(Buffer.from(query.data, "base64").toString("utf8")) as {
                transaction_uuid?: string;
              };

              return decoded.transaction_uuid ?? "";
            } catch {
              return "";
            }
          })()
        : "");

    if (!purchaseOrderId) {
      throw new AppError(400, "INVALID_CALLBACK", "Payment reference is missing");
    }

    const payment = await deps.prisma.payment.findUnique({
      where: { purchaseOrderId },
      include: { plan: true, subscription: true },
    });

    if (!payment || payment.provider !== providerId) {
      throw AppError.notFound("Payment not found");
    }

    const provider = providerId === "ESEWA" ? deps.providers.esewa : deps.providers.khalti;
    const intent = intentFor(payment);
    const result = await provider.confirmReturn(query, intent);
    await recordEvent(payment.id, providerId, "CALLBACK", query, result.signatureValid ?? null);
    await applyResult(payment.id, result);

    return {
      status: result.status,
      paymentId: payment.id,
      returnTo: `${deps.env.APP_WEB_URL.replace(/\/$/, "")}/billing?paymentId=${payment.id}`,
    };
  }

  async function checkStatus(businessId: string, paymentId: string) {
    const payment = await deps.prisma.payment.findFirst({
      where: { id: paymentId, businessId },
      include: { plan: true, subscription: true, invoice: true },
    });

    if (!payment) {
      throw AppError.notFound("Payment not found");
    }

    if (payment.status === "INITIATED" && payment.provider !== "BANK_TRANSFER") {
      const provider =
        payment.provider === "ESEWA" ? deps.providers.esewa : deps.providers.khalti;

      try {
        const result = await provider.status({
          ...intentFor(payment),
          providerRef: payment.providerRef ?? payment.purchaseOrderId,
        });
        await recordEvent(payment.id, payment.provider, "STATUS", result.raw, result.signatureValid ?? null);
        await applyResult(payment.id, result);
      } catch {
        // Keep the initiated state when provider status is unavailable.
      }
    }

    return deps.prisma.payment.findUnique({
      where: { id: paymentId },
      include: { plan: true, invoice: true },
    });
  }

  function intentFor(payment: {
    id: string;
    purchaseOrderId: string;
    amountPaisa: number;
    taxPaisa: number;
    plan: { name: string };
  }): PaymentIntent {
    return {
      paymentId: payment.id,
      purchaseOrderId: payment.purchaseOrderId,
      amountPaisa: payment.amountPaisa,
      taxPaisa: payment.taxPaisa,
      planName: payment.plan.name,
      returnUrl: `${deps.env.PUBLIC_API_URL.replace(/\/$/, "")}/v1/public/payments/callback`,
      successUrl: `${deps.env.APP_WEB_URL.replace(/\/$/, "")}/billing`,
      failureUrl: `${deps.env.APP_WEB_URL.replace(/\/$/, "")}/billing`,
    };
  }

  async function recordEvent(
    paymentId: string | null,
    provider: PayProvider,
    type: string,
    payload: Record<string, unknown>,
    signatureValid: boolean | null,
  ) {
    await deps.prisma.paymentEvent.create({
      data: {
        paymentId,
        provider,
        type,
        payload: payload as Prisma.InputJsonValue,
        signatureValid,
      },
    });
  }

  async function applyResult(paymentId: string, result: ConfirmResult) {
    const payment = await deps.prisma.payment.findUnique({
      where: { id: paymentId },
      include: { plan: true, subscription: true, business: true },
    });

    if (!payment || payment.status === "COMPLETED") {
      return;
    }

    if (result.signatureValid === false) {
      await deps.prisma.payment.update({
        where: { id: payment.id },
        data: { status: "FAILED", failureReason: "Signature verification failed" },
      });

      return;
    }

    if (result.status !== "COMPLETED") {
      await deps.prisma.payment.update({
        where: { id: payment.id },
        data: {
          status: result.status,
          providerRef: result.providerRef,
          providerTxnId: result.providerTxnId,
        },
      });

      return;
    }

    if (result.amountPaisa !== null && result.amountPaisa !== payment.amountPaisa) {
      await deps.prisma.payment.update({
        where: { id: payment.id },
        data: {
          status: "AMBIGUOUS",
          providerRef: result.providerRef,
          providerTxnId: result.providerTxnId,
          failureReason: "Paid amount does not match the invoice amount",
        },
      });

      return;
    }

    await deps.prisma.$transaction(async (tx) => {
      const updated = await tx.payment.update({
        where: { id: payment.id },
        data: {
          status: "COMPLETED",
          providerRef: result.providerRef,
          providerTxnId: result.providerTxnId,
          verifiedAt: now(),
          failureReason: null,
        },
      });
      const subscription = payment.subscription;

      if (!subscription) {
        return;
      }

      const at = now();
      const periodEnd = new Date(at.getTime() + 30 * 86_400_000);
      const limits = planLimits(payment.plan);

      await tx.subscription.update({
        where: { id: subscription.id },
        data: {
          planId: payment.planId,
          status: "ACTIVE",
          pricePaisaSnapshot: payment.plan.pricePaisa,
          limitsSnapshot: limits,
          currentPeriodStart: at,
          currentPeriodEnd: periodEnd,
          graceEndsAt: null,
          pendingPlanId: null,
          cancelAtPeriodEnd: false,
        },
      });
      await tx.usagePeriod.updateMany({
        where: { businessId: payment.businessId, periodEnd: null },
        data: { periodEnd: at },
      });
      await deps.quota.createPeriod(tx, {
        businessId: payment.businessId,
        subscriptionId: subscription.id,
        periodStart: at,
        periodEnd,
        postsLimit: payment.plan.postsPerPeriod,
        reelsLimit: payment.plan.reelsPerPeriod,
      });
      const invoice = await createInvoice(tx, updated, payment.business, payment.plan);
      await tx.payment.update({
        where: { id: payment.id },
        data: { invoice: { connect: { id: invoice.id } } },
      });
    });

    await deps.notifications.notify({
      userId: payment.business.ownerId,
      businessId: payment.businessId,
      type: "PAYMENT_COMPLETED",
      titleNe: "भुक्तानी सफल भयो",
      titleEn: "Payment successful",
      bodyNe: `${payment.plan.name} योजना सक्रिय भयो।`,
      bodyEn: `Your ${payment.plan.name} plan is now active.`,
      data: { paymentId: payment.id, planId: payment.planId },
      channels: ["IN_APP", "PUSH"],
      dedupeKey: `payment-completed:${payment.id}`,
    });
  }

  async function createInvoice(
    tx: Prisma.TransactionClient,
    payment: {
      id: string;
      amountPaisa: number;
      taxPaisa: number;
    },
    business: { id: string; name: string; panNumber: string | null },
    plan: { name: string },
  ) {
    const year = fiscalYear(now());
    const sequence = await tx.invoiceSequence.upsert({
      where: { fiscalYear: year },
      create: { fiscalYear: year, last: 1 },
      update: { last: { increment: 1 } },
    });
    const number = `RF-${year}-${String(sequence.last).padStart(5, "0")}`;
    const subtotal = payment.amountPaisa - payment.taxPaisa;
    const invoice = await tx.invoice.create({
      data: {
        paymentId: payment.id,
        businessId: business.id,
        number,
        fiscalYear: year,
        subtotalPaisa: subtotal,
        vatPaisa: payment.taxPaisa,
        totalPaisa: payment.amountPaisa,
        vatRateBp: deps.env.VAT_RATE_BP,
        buyerName: business.name,
        buyerPan: business.panNumber,
      },
    });
    const html = `<!doctype html><html><body>
      <h1>Redflie Invoice ${number}</h1>
      <p>${business.name}</p>
      <p>Plan: ${plan.name}</p>
      <p>Subtotal: ${formatNpr(subtotal)}</p>
      <p>VAT: ${formatNpr(payment.taxPaisa)}</p>
      <p>Total: ${formatNpr(payment.amountPaisa)}</p>
      <p>Date: ${formatBsFull(now(), "EN")}</p>
    </body></html>`;

    try {
      const pdf = await deps.renderer.pdf(html);
      const asset = await deps.assets.saveBuffer({
        businessId: business.id,
        kind: "invoice",
        buffer: pdf,
        mime: "application/pdf",
        isPublic: false,
      });
      await tx.invoice.update({
        where: { id: invoice.id },
        data: { pdfAssetId: asset.id },
      });
    } catch {
      // Invoice remains valid without the generated PDF.
    }

    return invoice;
  }

  async function invoices(businessId: string) {
    return deps.prisma.invoice.findMany({
      where: { businessId },
      orderBy: { issuedAt: "desc" },
      take: 100,
    });
  }

  async function invoicePdf(businessId: string, invoiceId: string) {
    const invoice = await deps.prisma.invoice.findFirst({
      where: { id: invoiceId, businessId },
    });

    if (!invoice?.pdfAssetId) {
      throw AppError.notFound("Invoice PDF not found");
    }

    const asset = await deps.assets.get(businessId, invoice.pdfAssetId);

    return { invoice, url: await deps.assets.urlFor(asset) };
  }

  async function cancel(businessId: string) {
    const subscription = await subscriptionFor(businessId);

    if (!subscription) {
      throw AppError.notFound("Subscription not found");
    }

    return deps.prisma.subscription.update({
      where: { id: subscription.id },
      data: { cancelAtPeriodEnd: true },
    });
  }

  async function resume(businessId: string) {
    const subscription = await subscriptionFor(businessId);

    if (!subscription) {
      throw AppError.notFound("Subscription not found");
    }

    return deps.prisma.subscription.update({
      where: { id: subscription.id },
      data: { cancelAtPeriodEnd: false, status: "ACTIVE", graceEndsAt: null },
    });
  }

  async function processRenewals(): Promise<{ grace: number; expired: number }> {
    const at = now();
    const due = await deps.prisma.subscription.findMany({
      where: { status: "ACTIVE", currentPeriodEnd: { lte: at } },
      include: { business: true },
    });
    let grace = 0;

    for (const subscription of due) {
      const graceEndsAt = new Date(at.getTime() + deps.env.GRACE_DAYS * 86_400_000);
      await deps.prisma.subscription.update({
        where: { id: subscription.id },
        data: { status: "GRACE", graceEndsAt },
      });
      await deps.notifications.notify({
        userId: subscription.business.ownerId,
        businessId: subscription.businessId,
        type: "SUBSCRIPTION_GRACE",
        titleNe: "योजना नवीकरण गर्नुहोस्",
        titleEn: "Renew your plan",
        bodyNe: "तपाईंको योजना सकिएको छ। सेवा जारी राख्न नवीकरण गर्नुहोस्।",
        bodyEn: "Your plan has ended. Renew to keep publishing.",
        data: { subscriptionId: subscription.id },
        channels: ["IN_APP", "PUSH", "SMS"],
        critical: true,
        dedupeKey: `grace:${subscription.id}:${at.toISOString().slice(0, 10)}`,
      });
      grace += 1;
    }

    const expiredRows = await deps.prisma.subscription.findMany({
      where: { status: "GRACE", graceEndsAt: { lte: at } },
    });

    for (const subscription of expiredRows) {
      await deps.prisma.subscription.update({
        where: { id: subscription.id },
        data: { status: "EXPIRED" },
      });
    }

    return { grace, expired: expiredRows.length };
  }

  async function expireStalePayments(): Promise<number> {
    const result = await deps.prisma.payment.updateMany({
      where: {
        status: { in: ["INITIATED", "PENDING"] },
        expiresAt: { lte: now() },
        provider: { not: "BANK_TRANSFER" },
      },
      data: { status: "EXPIRED" },
    });

    return result.count;
  }

  async function subscriptionView(businessId: string) {
    const subscription = await deps.prisma.subscription.findUnique({
      where: { businessId },
      include: { plan: true, pendingPlan: true },
    });

    if (!subscription) {
      return null;
    }

    return {
      ...subscription,
      quota: await deps.quota.view(businessId).catch(() => null),
    };
  }

  return {
    plans,
    subscriptionFor,
    subscriptionView,
    upgradeQuote,
    initiatePayment,
    initiateBankTransfer,
    submitBankProof,
    handleCallback,
    checkStatus,
    applyResult,
    recordEvent,
    invoices,
    invoicePdf,
    cancel,
    resume,
    processRenewals,
    expireStalePayments,
    taxBreakdown,
  };
}

export type { Subscription };

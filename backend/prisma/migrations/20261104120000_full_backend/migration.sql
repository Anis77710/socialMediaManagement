-- CreateEnum
CREATE TYPE "AutonomyMode" AS ENUM ('MANUAL', 'APPROVAL', 'AUTOPILOT');

-- CreateEnum
CREATE TYPE "AccountStatus" AS ENUM ('ACTIVE', 'NEEDS_REAUTH', 'REVOKED');

-- CreateEnum
CREATE TYPE "TargetStatus" AS ENUM ('QUEUED', 'PUBLISHING', 'PUBLISHED', 'FAILED', 'SKIPPED', 'CANCELED');

-- CreateEnum
CREATE TYPE "PostSource" AS ENUM ('MANUAL', 'IDEA', 'FESTIVAL_CAMPAIGN', 'AUTOPILOT', 'STAFF');

-- CreateEnum
CREATE TYPE "PostFormat" AS ENUM ('IMAGE', 'REEL');

-- CreateEnum
CREATE TYPE "SubStatus" AS ENUM ('ACTIVE', 'GRACE', 'EXPIRED', 'CANCELED');

-- CreateEnum
CREATE TYPE "QuotaPeriod" AS ENUM ('LIFETIME', 'SUBSCRIPTION');

-- CreateEnum
CREATE TYPE "PayProvider" AS ENUM ('ESEWA', 'KHALTI', 'BANK_TRANSFER', 'MANUAL');

-- CreateEnum
CREATE TYPE "PayStatus" AS ENUM ('INITIATED', 'PENDING', 'COMPLETED', 'FAILED', 'CANCELED', 'EXPIRED', 'REFUNDED', 'PARTIALLY_REFUNDED', 'AMBIGUOUS');

-- AlterEnum
BEGIN;
CREATE TYPE "Platform_new" AS ENUM ('FACEBOOK', 'INSTAGRAM', 'TIKTOK', 'GOOGLE_BUSINESS');
ALTER TABLE "social_accounts" ALTER COLUMN "platform" TYPE "Platform_new"
  USING (
    CASE "platform"::text
      WHEN 'INSTAGRAM' THEN 'INSTAGRAM'
      WHEN 'TIKTOK' THEN 'TIKTOK'
      ELSE 'FACEBOOK'
    END
  )::"Platform_new";
ALTER TYPE "Platform" RENAME TO "Platform_old";
ALTER TYPE "Platform_new" RENAME TO "Platform";
DROP TYPE "Platform_old";
COMMIT;

-- AlterEnum
BEGIN;
CREATE TYPE "PostStatus_new" AS ENUM ('DRAFT', 'IN_REVIEW', 'PENDING_APPROVAL', 'READY', 'SCHEDULED', 'PUBLISHING', 'PUBLISHED', 'PARTIALLY_PUBLISHED', 'FAILED', 'REJECTED', 'CANCELED', 'ON_HOLD', 'EXPIRED');
ALTER TABLE "posts" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "posts" ALTER COLUMN "status" TYPE "PostStatus_new"
  USING (
    CASE "status"::text
      WHEN 'CANCELLED' THEN 'CANCELED'
      ELSE "status"::text
    END
  )::"PostStatus_new";
ALTER TYPE "PostStatus" RENAME TO "PostStatus_old";
ALTER TYPE "PostStatus_new" RENAME TO "PostStatus";
DROP TYPE "PostStatus_old";
ALTER TABLE "posts" ALTER COLUMN "status" SET DEFAULT 'DRAFT';
COMMIT;

-- Expand phase: keep legacy columns until a later contract release so old
-- reporting jobs and rollbacks keep working.
ALTER TABLE "social_accounts"
ALTER COLUMN "accessToken" DROP NOT NULL,
ALTER COLUMN "platformAccountId" DROP NOT NULL,
ALTER COLUMN "userId" DROP NOT NULL,
ALTER COLUMN "username" DROP NOT NULL,
ADD COLUMN     "accessTokenEnc" TEXT,
ADD COLUMN     "businessId" TEXT,
ADD COLUMN     "connectedById" TEXT,
ADD COLUMN     "externalId" TEXT,
ADD COLUMN     "lastCheckedAt" TIMESTAMP(3),
ADD COLUMN     "lastError" TEXT,
ADD COLUMN     "meta" JSONB,
ADD COLUMN     "refreshTokenEnc" TEXT,
ADD COLUMN     "revokedAt" TIMESTAMP(3),
ADD COLUMN     "scopes" TEXT[],
ADD COLUMN     "status" "AccountStatus" NOT NULL DEFAULT 'ACTIVE',
ADD COLUMN     "userTokenEnc" TEXT;

ALTER TABLE "posts"
ALTER COLUMN "content" DROP NOT NULL,
ALTER COLUMN "userId" DROP NOT NULL,
ADD COLUMN     "brief" TEXT,
ADD COLUMN     "businessId" TEXT,
ADD COLUMN     "campaignId" TEXT,
ADD COLUMN     "caption" TEXT,
ADD COLUMN     "createdById" TEXT,
ADD COLUMN     "currentCreativeId" TEXT,
ADD COLUMN     "failureCode" TEXT,
ADD COLUMN     "festivalId" TEXT,
ADD COLUMN     "format" "PostFormat" NOT NULL DEFAULT 'IMAGE',
ADD COLUMN     "hasOfferFacts" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "holdReason" TEXT,
ADD COLUMN     "idempotencyKey" TEXT,
ADD COLUMN     "language" "Lang",
ADD COLUMN     "occasion" TEXT,
ADD COLUMN     "quotaConsumedAt" TIMESTAMP(3),
ADD COLUMN     "requiresApproval" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "source" "PostSource" NOT NULL DEFAULT 'MANUAL',
ADD COLUMN     "title" TEXT;

ALTER TABLE "post_targets"
ADD COLUMN     "attempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "errorCode" TEXT,
ADD COLUMN     "errorDetail" TEXT,
ADD COLUMN     "externalPostId" TEXT,
ADD COLUMN     "externalUrl" TEXT,
ADD COLUMN     "idempotencyKey" TEXT,
ADD COLUMN     "nextAttemptAt" TIMESTAMP(3),
ADD COLUMN     "providerContainerId" TEXT,
ALTER COLUMN "status" DROP DEFAULT,
ALTER COLUMN "status" DROP NOT NULL,
ALTER COLUMN "status" TYPE TEXT USING ("status"::text),
ALTER COLUMN "status" TYPE "TargetStatus" USING (
  CASE "status"
    WHEN 'PUBLISHED' THEN 'PUBLISHED'
    WHEN 'FAILED' THEN 'FAILED'
    ELSE 'QUEUED'
  END
)::"TargetStatus",
ALTER COLUMN "status" SET DEFAULT 'QUEUED',
ALTER COLUMN "status" SET NOT NULL;

-- AlterTable
ALTER TABLE "audit_logs" ADD COLUMN     "impersonatingUserId" TEXT;

-- Legacy media tables are retained during the expand phase. A later contract
-- migration can drop them once no reporting job or rollback reads them.

-- CreateTable
CREATE TABLE "devices" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "pushToken" TEXT NOT NULL,
    "lastSeenAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "devices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "business_categories" (
    "id" TEXT NOT NULL,
    "nameNe" TEXT NOT NULL,
    "nameEn" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "business_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "towns" (
    "id" TEXT NOT NULL,
    "nameNe" TEXT NOT NULL,
    "nameEn" TEXT NOT NULL,
    "district" TEXT NOT NULL,
    "province" INTEGER NOT NULL,
    "regionTags" TEXT[],
    "lat" DOUBLE PRECISION,
    "lng" DOUBLE PRECISION,

    CONSTRAINT "towns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "businesses" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "townId" TEXT,
    "townText" TEXT NOT NULL,
    "customerPhone" TEXT,
    "language" "Lang" NOT NULL DEFAULT 'NE',
    "panNumber" TEXT,
    "logoAssetId" TEXT,
    "autonomyMode" "AutonomyMode" NOT NULL DEFAULT 'APPROVAL',
    "onboardingStep" TEXT NOT NULL DEFAULT 'BUSINESS',
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "businesses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "business_members" (
    "businessId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'OWNER',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "business_members_pkey" PRIMARY KEY ("businessId","userId")
);

-- CreateTable
CREATE TABLE "plans" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "pricePaisa" INTEGER NOT NULL,
    "postsPerPeriod" INTEGER NOT NULL,
    "reelsPerPeriod" INTEGER NOT NULL,
    "maxAccounts" INTEGER NOT NULL,
    "quotaPeriod" "QuotaPeriod" NOT NULL DEFAULT 'SUBSCRIPTION',
    "features" JSONB NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subscriptions" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "status" "SubStatus" NOT NULL DEFAULT 'ACTIVE',
    "pricePaisaSnapshot" INTEGER NOT NULL,
    "limitsSnapshot" JSONB NOT NULL,
    "currentPeriodStart" TIMESTAMP(3) NOT NULL,
    "currentPeriodEnd" TIMESTAMP(3),
    "graceEndsAt" TIMESTAMP(3),
    "cancelAtPeriodEnd" BOOLEAN NOT NULL DEFAULT false,
    "pendingPlanId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "usage_periods" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "subscriptionId" TEXT NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3),
    "postsLimit" INTEGER NOT NULL,
    "postsUsed" INTEGER NOT NULL DEFAULT 0,
    "reelsLimit" INTEGER NOT NULL,
    "reelsUsed" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "usage_periods_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payments" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "subscriptionId" TEXT,
    "planId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "provider" "PayProvider" NOT NULL,
    "status" "PayStatus" NOT NULL DEFAULT 'INITIATED',
    "amountPaisa" INTEGER NOT NULL,
    "taxPaisa" INTEGER NOT NULL DEFAULT 0,
    "providerRef" TEXT,
    "providerTxnId" TEXT,
    "purchaseOrderId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "verifiedAt" TIMESTAMP(3),
    "failureReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_events" (
    "id" TEXT NOT NULL,
    "paymentId" TEXT,
    "provider" "PayProvider" NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "signatureValid" BOOLEAN,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bank_transfer_proofs" (
    "id" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "bankName" TEXT NOT NULL,
    "referenceNo" TEXT NOT NULL,
    "paidAt" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "reviewedById" TEXT,
    "reviewNote" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bank_transfer_proofs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoices" (
    "id" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "fiscalYear" TEXT NOT NULL,
    "subtotalPaisa" INTEGER NOT NULL,
    "vatPaisa" INTEGER NOT NULL,
    "totalPaisa" INTEGER NOT NULL,
    "vatRateBp" INTEGER NOT NULL,
    "buyerName" TEXT NOT NULL,
    "buyerPan" TEXT,
    "pdfAssetId" TEXT,
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invoices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoice_sequences" (
    "fiscalYear" TEXT NOT NULL,
    "last" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "invoice_sequences_pkey" PRIMARY KEY ("fiscalYear")
);

-- CreateTable
CREATE TABLE "oauth_states" (
    "state" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "platform" "Platform" NOT NULL,
    "pkceVerifier" TEXT,
    "returnTo" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "oauth_states_pkey" PRIMARY KEY ("state")
);

-- CreateTable
CREATE TABLE "assets" (
    "id" TEXT NOT NULL,
    "businessId" TEXT,
    "kind" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "mime" TEXT NOT NULL,
    "bytes" INTEGER NOT NULL,
    "width" INTEGER,
    "height" INTEGER,
    "sha256" TEXT NOT NULL,
    "isPublic" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "assets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "creatives" (
    "id" TEXT NOT NULL,
    "postId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "variant" INTEGER NOT NULL,
    "templateKey" TEXT NOT NULL,
    "inverted" BOOLEAN NOT NULL,
    "eyebrow" TEXT NOT NULL,
    "headline" TEXT NOT NULL,
    "value" TEXT,
    "unit" TEXT,
    "caption" TEXT NOT NULL,
    "facts" JSONB NOT NULL,
    "aiMeta" JSONB,
    "validation" JSONB NOT NULL,
    "renderStatus" TEXT NOT NULL DEFAULT 'PENDING',
    "assetId" TEXT,
    "contentHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "creatives_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "approvals" (
    "id" TEXT NOT NULL,
    "postId" TEXT NOT NULL,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "decision" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decidedById" TEXT,
    "feedback" TEXT,

    CONSTRAINT "approvals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "review_tasks" (
    "id" TEXT NOT NULL,
    "postId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "slaDueAt" TIMESTAMP(3) NOT NULL,
    "assignedToId" TEXT,
    "checklist" JSONB,
    "notes" TEXT,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "review_tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "copy_templates" (
    "id" TEXT NOT NULL,
    "lang" "Lang" NOT NULL,
    "occasion" TEXT NOT NULL,
    "slot" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "weight" INTEGER NOT NULL DEFAULT 1,
    "categoryIds" TEXT[],
    "active" BOOLEAN NOT NULL DEFAULT true,
    "reviewedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "copy_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "idea_templates" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "titleNe" TEXT NOT NULL,
    "titleEn" TEXT NOT NULL,
    "whyNe" TEXT NOT NULL,
    "whyEn" TEXT NOT NULL,
    "briefNe" TEXT NOT NULL,
    "briefEn" TEXT NOT NULL,
    "categoryIds" TEXT[],
    "festivalId" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "idea_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "poster_templates" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "aspect" TEXT NOT NULL,
    "htmlSource" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "poster_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "glossary" (
    "id" TEXT NOT NULL,
    "lang" "Lang" NOT NULL,
    "term" TEXT NOT NULL,
    "preferred" TEXT NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "glossary_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "festivals" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "nameNe" TEXT NOT NULL,
    "nameEn" TEXT NOT NULL,
    "adDate" DATE NOT NULL,
    "bsYear" INTEGER NOT NULL,
    "bsMonth" INTEGER NOT NULL,
    "bsDay" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "regionTags" TEXT[],
    "categoryRelevance" JSONB NOT NULL,
    "leadTimeDays" INTEGER NOT NULL DEFAULT 14,
    "keywords" TEXT[],
    "verifiedById" TEXT,
    "verifiedAt" TIMESTAMP(3),
    "published" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "festivals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "campaigns" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "festivalId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PLANNED',
    "plannedPosts" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "campaigns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "automation_rules" (
    "businessId" TEXT NOT NULL,
    "maxPostsPerWeek" INTEGER NOT NULL DEFAULT 3,
    "allowedWeekdays" INTEGER[],
    "windowStart" TEXT NOT NULL DEFAULT '10:00',
    "windowEnd" TEXT NOT NULL DEFAULT '19:00',
    "blockedKeywords" TEXT[],
    "accountIds" TEXT[],
    "paused" BOOLEAN NOT NULL DEFAULT false,
    "pausedUntil" TIMESTAMP(3),
    "adBudgetCapPaisa" INTEGER NOT NULL DEFAULT 0,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "automation_rules_pkey" PRIMARY KEY ("businessId")
);

-- CreateTable
CREATE TABLE "insight_snapshots" (
    "id" TEXT NOT NULL,
    "socialAccountId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "metrics" JSONB NOT NULL,
    "isFinal" BOOLEAN NOT NULL DEFAULT false,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "insight_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "post_insights" (
    "id" TEXT NOT NULL,
    "postTargetId" TEXT NOT NULL,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "metrics" JSONB NOT NULL,

    CONSTRAINT "post_insights_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sales_records" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "amountPaisa" INTEGER NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'MANUAL',
    "note" TEXT,
    "attributedPostId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sales_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "weekly_reports" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "weekStart" DATE NOT NULL,
    "numbers" JSONB NOT NULL,
    "textNe" TEXT NOT NULL,
    "textEn" TEXT NOT NULL,
    "aiMeta" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "weekly_reports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "businessId" TEXT,
    "type" TEXT NOT NULL,
    "titleNe" TEXT NOT NULL,
    "titleEn" TEXT NOT NULL,
    "bodyNe" TEXT NOT NULL,
    "bodyEn" TEXT NOT NULL,
    "data" JSONB,
    "channels" TEXT[],
    "dedupeKey" TEXT,
    "readAt" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_preferences" (
    "userId" TEXT NOT NULL,
    "channels" TEXT[],
    "quietHours" BOOLEAN NOT NULL DEFAULT true,
    "language" "Lang" NOT NULL DEFAULT 'NE',
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_preferences_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "support_tickets" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "assignedToId" TEXT,
    "priority" TEXT NOT NULL DEFAULT 'NORMAL',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "support_tickets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ticket_messages" (
    "id" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "authorType" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "internal" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ticket_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "data_requests" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "dueAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),
    "assetId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "data_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "feature_flags" (
    "key" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL,
    "rollout" JSONB,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "feature_flags_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "system_settings" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "system_settings_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "outbox_events" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "outbox_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "idempotency_records" (
    "key" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "response" JSONB,
    "status" INTEGER,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "idempotency_records_pkey" PRIMARY KEY ("scope","key")
);

-- CreateTable
CREATE TABLE "webhook_events" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "externalId" TEXT,
    "payload" JSONB NOT NULL,
    "signatureValid" BOOLEAN NOT NULL,
    "processedAt" TIMESTAMP(3),
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "webhook_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ad_campaigns" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "postId" TEXT,
    "budgetApprovedPaisa" INTEGER NOT NULL,
    "spentPaisa" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'PENDING_APPROVAL',
    "approvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ad_campaigns_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "devices_pushToken_key" ON "devices"("pushToken");

-- CreateIndex
CREATE INDEX "devices_userId_idx" ON "devices"("userId");

-- CreateIndex
CREATE INDEX "towns_nameEn_idx" ON "towns"("nameEn");

-- CreateIndex
CREATE INDEX "towns_nameNe_idx" ON "towns"("nameNe");

-- CreateIndex
CREATE INDEX "businesses_ownerId_idx" ON "businesses"("ownerId");

-- CreateIndex
CREATE INDEX "businesses_status_idx" ON "businesses"("status");

-- CreateIndex
CREATE INDEX "businesses_categoryId_idx" ON "businesses"("categoryId");

-- CreateIndex
CREATE INDEX "business_members_userId_idx" ON "business_members"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "subscriptions_businessId_key" ON "subscriptions"("businessId");

-- CreateIndex
CREATE INDEX "subscriptions_status_currentPeriodEnd_idx" ON "subscriptions"("status", "currentPeriodEnd");

-- CreateIndex
CREATE INDEX "usage_periods_businessId_periodEnd_idx" ON "usage_periods"("businessId", "periodEnd");

-- CreateIndex
CREATE UNIQUE INDEX "usage_periods_businessId_periodStart_key" ON "usage_periods"("businessId", "periodStart");

-- CreateIndex
CREATE UNIQUE INDEX "payments_purchaseOrderId_key" ON "payments"("purchaseOrderId");

-- CreateIndex
CREATE INDEX "payments_businessId_status_idx" ON "payments"("businessId", "status");

-- CreateIndex
CREATE INDEX "payments_status_createdAt_idx" ON "payments"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "payments_provider_providerRef_key" ON "payments"("provider", "providerRef");

-- CreateIndex
CREATE INDEX "payment_events_paymentId_idx" ON "payment_events"("paymentId");

-- CreateIndex
CREATE UNIQUE INDEX "bank_transfer_proofs_paymentId_key" ON "bank_transfer_proofs"("paymentId");

-- CreateIndex
CREATE INDEX "bank_transfer_proofs_status_idx" ON "bank_transfer_proofs"("status");

-- CreateIndex
CREATE UNIQUE INDEX "invoices_paymentId_key" ON "invoices"("paymentId");

-- CreateIndex
CREATE UNIQUE INDEX "invoices_number_key" ON "invoices"("number");

-- CreateIndex
CREATE INDEX "invoices_businessId_issuedAt_idx" ON "invoices"("businessId", "issuedAt");

-- CreateIndex
CREATE INDEX "oauth_states_expiresAt_idx" ON "oauth_states"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "assets_storageKey_key" ON "assets"("storageKey");

-- CreateIndex
CREATE INDEX "assets_businessId_kind_idx" ON "assets"("businessId", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "creatives_postId_version_key" ON "creatives"("postId", "version");

-- CreateIndex
CREATE INDEX "approvals_postId_idx" ON "approvals"("postId");

-- CreateIndex
CREATE INDEX "approvals_decision_expiresAt_idx" ON "approvals"("decision", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "review_tasks_postId_key" ON "review_tasks"("postId");

-- CreateIndex
CREATE INDEX "review_tasks_status_slaDueAt_idx" ON "review_tasks"("status", "slaDueAt");

-- CreateIndex
CREATE INDEX "copy_templates_lang_occasion_slot_active_idx" ON "copy_templates"("lang", "occasion", "slot", "active");

-- CreateIndex
CREATE UNIQUE INDEX "idea_templates_key_key" ON "idea_templates"("key");

-- CreateIndex
CREATE UNIQUE INDEX "poster_templates_key_key" ON "poster_templates"("key");

-- CreateIndex
CREATE UNIQUE INDEX "glossary_lang_term_key" ON "glossary"("lang", "term");

-- CreateIndex
CREATE UNIQUE INDEX "festivals_slug_key" ON "festivals"("slug");

-- CreateIndex
CREATE INDEX "festivals_adDate_published_idx" ON "festivals"("adDate", "published");

-- CreateIndex
CREATE UNIQUE INDEX "campaigns_businessId_festivalId_key" ON "campaigns"("businessId", "festivalId");

-- CreateIndex
CREATE UNIQUE INDEX "insight_snapshots_socialAccountId_date_key" ON "insight_snapshots"("socialAccountId", "date");

-- CreateIndex
CREATE INDEX "post_insights_postTargetId_idx" ON "post_insights"("postTargetId");

-- CreateIndex
CREATE INDEX "sales_records_businessId_occurredAt_idx" ON "sales_records"("businessId", "occurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "weekly_reports_businessId_weekStart_key" ON "weekly_reports"("businessId", "weekStart");

-- CreateIndex
CREATE UNIQUE INDEX "notifications_dedupeKey_key" ON "notifications"("dedupeKey");

-- CreateIndex
CREATE INDEX "notifications_userId_readAt_createdAt_idx" ON "notifications"("userId", "readAt", "createdAt");

-- CreateIndex
CREATE INDEX "support_tickets_status_createdAt_idx" ON "support_tickets"("status", "createdAt");

-- CreateIndex
CREATE INDEX "ticket_messages_ticketId_createdAt_idx" ON "ticket_messages"("ticketId", "createdAt");

-- CreateIndex
CREATE INDEX "data_requests_status_dueAt_idx" ON "data_requests"("status", "dueAt");

-- CreateIndex
CREATE INDEX "outbox_events_processedAt_availableAt_idx" ON "outbox_events"("processedAt", "availableAt");

-- CreateIndex
CREATE INDEX "idempotency_records_expiresAt_idx" ON "idempotency_records"("expiresAt");

-- CreateIndex
CREATE INDEX "webhook_events_processedAt_idx" ON "webhook_events"("processedAt");

-- CreateIndex
CREATE UNIQUE INDEX "webhook_events_provider_externalId_key" ON "webhook_events"("provider", "externalId");

-- CreateIndex
CREATE INDEX "ad_campaigns_businessId_status_idx" ON "ad_campaigns"("businessId", "status");

-- CreateIndex
CREATE INDEX "social_accounts_businessId_status_idx" ON "social_accounts"("businessId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "social_accounts_businessId_platform_externalId_key" ON "social_accounts"("businessId", "platform", "externalId");

-- CreateIndex
CREATE INDEX "posts_businessId_status_scheduledAt_idx" ON "posts"("businessId", "status", "scheduledAt");

-- CreateIndex
CREATE INDEX "posts_businessId_createdAt_idx" ON "posts"("businessId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "posts_businessId_idempotencyKey_key" ON "posts"("businessId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "post_targets_idempotencyKey_key" ON "post_targets"("idempotencyKey");

-- CreateIndex
CREATE INDEX "post_targets_status_nextAttemptAt_idx" ON "post_targets"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "post_targets_postId_idx" ON "post_targets"("postId");

-- AddForeignKey
ALTER TABLE "consent_records" ADD CONSTRAINT "consent_records_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "devices" ADD CONSTRAINT "devices_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "businesses" ADD CONSTRAINT "businesses_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "businesses" ADD CONSTRAINT "businesses_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "business_categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "businesses" ADD CONSTRAINT "businesses_townId_fkey" FOREIGN KEY ("townId") REFERENCES "towns"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "business_members" ADD CONSTRAINT "business_members_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "business_members" ADD CONSTRAINT "business_members_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_planId_fkey" FOREIGN KEY ("planId") REFERENCES "plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_pendingPlanId_fkey" FOREIGN KEY ("pendingPlanId") REFERENCES "plans"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "usage_periods" ADD CONSTRAINT "usage_periods_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "usage_periods" ADD CONSTRAINT "usage_periods_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "subscriptions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "subscriptions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_planId_fkey" FOREIGN KEY ("planId") REFERENCES "plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_events" ADD CONSTRAINT "payment_events_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "payments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bank_transfer_proofs" ADD CONSTRAINT "bank_transfer_proofs_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "payments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "payments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "social_accounts" ADD CONSTRAINT "social_accounts_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assets" ADD CONSTRAINT "assets_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "businesses"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "posts" ADD CONSTRAINT "posts_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "posts" ADD CONSTRAINT "posts_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "creatives" ADD CONSTRAINT "creatives_postId_fkey" FOREIGN KEY ("postId") REFERENCES "posts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_postId_fkey" FOREIGN KEY ("postId") REFERENCES "posts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review_tasks" ADD CONSTRAINT "review_tasks_postId_fkey" FOREIGN KEY ("postId") REFERENCES "posts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_festivalId_fkey" FOREIGN KEY ("festivalId") REFERENCES "festivals"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "automation_rules" ADD CONSTRAINT "automation_rules_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "post_insights" ADD CONSTRAINT "post_insights_postTargetId_fkey" FOREIGN KEY ("postTargetId") REFERENCES "post_targets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_records" ADD CONSTRAINT "sales_records_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "weekly_reports" ADD CONSTRAINT "weekly_reports_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "businesses"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket_messages" ADD CONSTRAINT "ticket_messages_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "support_tickets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "data_requests" ADD CONSTRAINT "data_requests_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Domain integrity constraints (spec section 8.1)
-- ---------------------------------------------------------------------------
ALTER TABLE "usage_periods"
  ADD CONSTRAINT "usage_periods_posts_check"
  CHECK ("postsUsed" >= 0 AND "postsUsed" <= "postsLimit");

ALTER TABLE "usage_periods"
  ADD CONSTRAINT "usage_periods_reels_check"
  CHECK ("reelsUsed" >= 0 AND "reelsUsed" <= "reelsLimit");

ALTER TABLE "payments"
  ADD CONSTRAINT "payments_amount_check"
  CHECK ("amountPaisa" >= 0 AND "taxPaisa" >= 0);

ALTER TABLE "ad_campaigns"
  ADD CONSTRAINT "ad_campaigns_budget_check"
  CHECK ("spentPaisa" >= 0 AND "spentPaisa" <= "budgetApprovedPaisa");

-- Only one live connection per external account; revoked rows are kept for audit.
CREATE UNIQUE INDEX "social_accounts_active_external_key"
  ON "social_accounts" ("businessId", "platform", "externalId")
  WHERE "status" <> 'REVOKED';

-- Fast lookups used by the scheduler and analytics.
CREATE INDEX "post_targets_due_idx" ON "post_targets" ("status", "nextAttemptAt");
CREATE INDEX "outbox_events_pending_idx" ON "outbox_events" ("processedAt", "availableAt");
CREATE INDEX "notifications_unread_idx" ON "notifications" ("userId", "readAt");

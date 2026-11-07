-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'DELETION_PENDING', 'DELETED');

-- CreateEnum
CREATE TYPE "Lang" AS ENUM ('NE', 'EN');

-- AlterTable
ALTER TABLE "users" ALTER COLUMN "email" DROP NOT NULL;
ALTER TABLE "users" ALTER COLUMN "name" DROP NOT NULL;

-- Legacy email/password rows get a synthetic, never-verifiable phone so nothing is deleted.
ALTER TABLE "users" ADD COLUMN "phoneE164" TEXT;
UPDATE "users" AS u
SET "phoneE164" = '+97798' || lpad(seq.rn::text, 8, '0')
FROM (
    SELECT "id", row_number() OVER (ORDER BY "id") AS rn
    FROM "users"
) AS seq
WHERE u."id" = seq."id" AND u."phoneE164" IS NULL;
ALTER TABLE "users" ALTER COLUMN "phoneE164" SET NOT NULL;

ALTER TABLE "users" ADD COLUMN "phoneVerifiedAt" TIMESTAMP(3);
ALTER TABLE "users" ADD COLUMN "googleSub" TEXT;
ALTER TABLE "users" ADD COLUMN "locale" "Lang" NOT NULL DEFAULT 'NE';
ALTER TABLE "users" ADD COLUMN "status" "UserStatus" NOT NULL DEFAULT 'ACTIVE';
ALTER TABLE "users" ADD COLUMN "tokenVersion" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "users" ADD COLUMN "lastLoginAt" TIMESTAMP(3);
ALTER TABLE "users" ADD COLUMN "deletionRequestedAt" TIMESTAMP(3);
ALTER TABLE "users" ADD COLUMN "deletedAt" TIMESTAMP(3);

-- Legacy email/password accounts never verified a phone. Suspending them prevents the synthetic
-- numbers from becoming an account-takeover path; support must verify ownership before reactivation.
UPDATE "users" SET "status" = 'SUSPENDED' WHERE "phoneVerifiedAt" IS NULL;

ALTER TABLE "users" DROP COLUMN "passwordHash";

-- DropTable
DROP TABLE "refresh_tokens";

-- CreateTable
CREATE TABLE "sessions" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "familyId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "replacedById" TEXT,
    "rotatedAt" TIMESTAMP(3),
    "deviceName" TEXT,
    "platform" TEXT,
    "userAgent" TEXT,
    "ip" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "absoluteExpiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "revokeReason" TEXT,
    "lastUsedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "otp_challenges" (
    "id" TEXT NOT NULL,
    "phoneE164" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "sendCount" INTEGER NOT NULL DEFAULT 1,
    "userId" TEXT,
    "ip" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "otp_challenges_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "consent_records" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "document" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "acceptedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ip" TEXT,

    CONSTRAINT "consent_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "security_events" (
    "id" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "type" TEXT NOT NULL,
    "userId" TEXT,
    "phoneHash" TEXT,
    "phoneMasked" TEXT,
    "ip" TEXT,
    "userAgent" TEXT,
    "result" TEXT NOT NULL,
    "meta" JSONB,

    CONSTRAINT "security_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deny_list_entries" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "reason" TEXT,
    "expiresAt" TIMESTAMP(3),

    CONSTRAINT "deny_list_entries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_phoneE164_key" ON "users"("phoneE164");

-- CreateIndex
CREATE UNIQUE INDEX "users_googleSub_key" ON "users"("googleSub");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_tokenHash_key" ON "sessions"("tokenHash");

-- CreateIndex
CREATE INDEX "sessions_userId_revokedAt_idx" ON "sessions"("userId", "revokedAt");

-- CreateIndex
CREATE INDEX "sessions_familyId_idx" ON "sessions"("familyId");

-- CreateIndex
CREATE INDEX "otp_challenges_phoneE164_createdAt_idx" ON "otp_challenges"("phoneE164", "createdAt");

-- CreateIndex
CREATE INDEX "consent_records_userId_idx" ON "consent_records"("userId");

-- CreateIndex
CREATE INDEX "security_events_userId_at_idx" ON "security_events"("userId", "at");

-- CreateIndex
CREATE INDEX "security_events_phoneHash_at_idx" ON "security_events"("phoneHash", "at");

-- CreateIndex
CREATE UNIQUE INDEX "deny_list_entries_kind_value_key" ON "deny_list_entries"("kind", "value");

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

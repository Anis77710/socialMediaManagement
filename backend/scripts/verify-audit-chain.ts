import { PrismaPg } from "@prisma/adapter-pg";
import { env } from "../src/config/env.js";
import { PrismaClient } from "../src/generated/prisma/client.js";
import { createPrismaAuditRepo, verifyAuditChain } from "../src/lib/audit.js";

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: env.DATABASE_URL }),
});

try {
  const rows = await createPrismaAuditRepo(prisma).listAll();
  const result = verifyAuditChain(rows);

  if (result.valid) {
    console.log(`Audit chain valid (${rows.length} rows)`);
  } else {
    console.error(
      `Audit chain broken at ${result.brokenAtId}: ${result.reason}`,
    );
    process.exitCode = 1;
  }
} finally {
  await prisma.$disconnect();
}

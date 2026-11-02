import { PrismaPg } from "@prisma/adapter-pg";
import fp from "fastify-plugin";
import { env } from "../config/env.js";
import { PrismaClient } from "../generated/prisma/client.js";

export const prismaPlugin = fp(
  async (app) => {
    const adapter = new PrismaPg({
      connectionString: env.DATABASE_URL,
    });
    const prisma = new PrismaClient({ adapter });

    app.decorate("prisma", prisma);

    app.addHook("onClose", async () => {
      await prisma.$disconnect();
    });
  },
  {
    name: "prisma",
  },
);

import { PrismaPg } from "@prisma/adapter-pg";
import fp from "fastify-plugin";
import { env } from "../config/env.js";
import { PrismaClient } from "../generated/prisma/client.js";

type PrismaPluginOptions = {
  databaseUrl?: string;
};

export const prismaPlugin = fp<PrismaPluginOptions>(
  async (app, options) => {
    const adapter = new PrismaPg({
      connectionString: options.databaseUrl ?? env.DATABASE_URL,
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

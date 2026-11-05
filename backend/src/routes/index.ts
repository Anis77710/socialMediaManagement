import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";

export const legacyRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get("/posts", { preHandler: app.requireAuth }, async () => ({ data: [] }));
};

export { appRoutes } from "./app.js";
export { publicRoutes } from "./public.js";
export { newAdminRoutes } from "./admin.js";


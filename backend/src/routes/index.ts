import type { FastifyPluginAsync } from "fastify";
import { authRoutes } from "../modules/auth/auth.routes.js";
import { mediaRoutes } from "../modules/media/media.routes.js";
import { postRoutes } from "../modules/posts/post.routes.js";
import { socialAccountRoutes } from "../modules/social-accounts/social-account.routes.js";
import { userRoutes } from "../modules/users/user.routes.js";

export const apiRoutes: FastifyPluginAsync = async (app) => {
  await app.register(authRoutes, { prefix: "/auth" });
  await app.register(userRoutes, { prefix: "/users" });
  await app.register(socialAccountRoutes, { prefix: "/social-accounts" });
  await app.register(postRoutes, { prefix: "/posts" });
  await app.register(mediaRoutes, { prefix: "/media" });
};

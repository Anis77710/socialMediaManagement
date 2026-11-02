import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { idParamsSchema, paginationMetaSchema, postSchema } from "../../lib/schemas.js";
import { createPostSchema, listPostsQuerySchema, updatePostSchema } from "./post.schemas.js";
import { createPost, deletePost, getPost, listPosts, updatePost } from "./post.service.js";

export const postRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook("preHandler", app.authenticate);

  app.get(
    "/",
    {
      schema: {
        tags: ["Posts"],
        summary: "List posts",
        security: [{ bearerAuth: [] }],
        querystring: listPostsQuerySchema,
        response: {
          200: z.object({
            data: z.array(postSchema),
            meta: paginationMetaSchema,
          }),
        },
      },
    },
    async (request) => {
      const result = await listPosts(app, request.user.sub, request.query);
      return {
        data: result.posts,
        meta: result.meta,
      };
    },
  );

  app.get(
    "/:id",
    {
      schema: {
        tags: ["Posts"],
        summary: "Get a post",
        security: [{ bearerAuth: [] }],
        params: idParamsSchema,
        response: {
          200: z.object({ data: postSchema }),
        },
      },
    },
    async (request) => {
      const post = await getPost(app, request.user.sub, request.params.id);
      return { data: post };
    },
  );

  app.post(
    "/",
    {
      schema: {
        tags: ["Posts"],
        summary: "Create a post",
        security: [{ bearerAuth: [] }],
        body: createPostSchema,
        response: {
          201: z.object({ data: postSchema }),
        },
      },
    },
    async (request, reply) => {
      const post = await createPost(app, request.user.sub, request.body);
      return reply.code(201).send({ data: post });
    },
  );

  app.patch(
    "/:id",
    {
      schema: {
        tags: ["Posts"],
        summary: "Update a post",
        security: [{ bearerAuth: [] }],
        params: idParamsSchema,
        body: updatePostSchema,
        response: {
          200: z.object({ data: postSchema }),
        },
      },
    },
    async (request) => {
      const post = await updatePost(app, request.user.sub, request.params.id, request.body);
      return { data: post };
    },
  );

  app.delete(
    "/:id",
    {
      schema: {
        tags: ["Posts"],
        summary: "Delete a post",
        security: [{ bearerAuth: [] }],
        params: idParamsSchema,
        response: {
          204: z.null(),
        },
      },
    },
    async (request, reply) => {
      await deletePost(app, request.user.sub, request.params.id);
      return reply.code(204).send(null);
    },
  );
};

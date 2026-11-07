import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";

describe("health routes", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it("returns a liveness response", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/health",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: "ok",
    });
  });

  it("returns a problem+json not-found error", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/does-not-exist",
    });

    expect(response.statusCode).toBe(404);
    expect(response.headers["content-type"]).toContain("application/problem+json");
    expect(response.json()).toMatchObject({
      type: "about:blank",
      title: "Not Found",
      status: 404,
      code: "NOT_FOUND",
    });
  });

  it("rejects protected routes without a token", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/posts",
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({
      code: "UNAUTHORIZED",
    });
  });

  it("validates request payloads", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/app/auth/otp/request",
      payload: {},
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      code: "VALIDATION_ERROR",
    });
  });
});

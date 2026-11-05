import { createSharpRenderer } from "./sharp.js";
import type { Renderer } from "./types.js";

export function createRenderer(): Renderer {
  return createSharpRenderer();
}

export type { Renderer, PosterInput } from "./types.js";

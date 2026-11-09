import type { Context } from "hono";
import type { ZodType } from "zod";

export class HttpError extends Error {
  constructor(
    public readonly status: 400 | 401 | 402 | 403 | 404 | 409 | 422 | 429 | 500 | 502 | 503,
    public readonly code: string,
    message?: string,
    public readonly headers?: Record<string, string>,
  ) {
    super(message ?? code);
  }
}

export const badRequest = (code: string, message?: string) => new HttpError(400, code, message);
export const unauthorized = (code = "unauthenticated") => new HttpError(401, code);
export const forbidden = (code = "forbidden") => new HttpError(403, code);
export const notFound = (code = "not_found") => new HttpError(404, code);
export const conflict = (code: string) => new HttpError(409, code);

/** Lê e valida o corpo JSON. Nunca devolve campos extras não declarados no schema. */
export async function parseJson<T>(c: Context, schema: ZodType<T>): Promise<T> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw badRequest("invalid_json");
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new HttpError(422, "validation_error", parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  }
  return parsed.data;
}

export function clientIp(c: Context): string {
  // Em produção o tráfego passa pela Cloudflare, que define cf-connecting-ip.
  return c.req.header("cf-connecting-ip") ?? c.req.header("x-real-ip") ?? "local";
}

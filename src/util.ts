import { z } from "zod";
import { TurathError, log } from "./client.js";

export const MAX_CHARS = 30_000;
export const text = (data: unknown) => {
  let s = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  if (s.length > MAX_CHARS) s = s.slice(0, MAX_CHARS) + "\n…[truncated]";
  return { content: [{ type: "text" as const, text: s }] };
};
export const fail = (e: unknown) => ({
  isError: true,
  content: [{ type: "text" as const, text: e instanceof TurathError ? e.message : `Unexpected error: ${(e as Error).message}` }],
});
export const run = async <T>(fn: () => Promise<T>) => {
  try {
    return text(await fn());
  } catch (e) {
    log("tool error:", e);
    return fail(e);
  }
};

export const id = (what: string) => z.number().int().positive().describe(what);
export const readOnly = { readOnlyHint: true, openWorldHint: true } as const;


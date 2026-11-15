import { z } from "zod";
import { TurathError, log } from "./client.js";
export const MAX_CHARS = 30_000;
export const text = (data) => {
    let s = typeof data === "string" ? data : JSON.stringify(data, null, 2);
    if (s.length > MAX_CHARS)
        s = s.slice(0, MAX_CHARS) + "\n…[truncated]";
    return { content: [{ type: "text", text: s }] };
};
export const fail = (e) => ({
    isError: true,
    content: [{ type: "text", text: e instanceof TurathError ? e.message : `Unexpected error: ${e.message}` }],
});
export const run = async (fn) => {
    try {
        return text(await fn());
    }
    catch (e) {
        log("tool error:", e);
        return fail(e);
    }
};
export const id = (what) => z.number().int().positive().describe(what);
export const readOnly = { readOnlyHint: true, openWorldHint: true };

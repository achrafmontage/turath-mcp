/**
 * Advanced MCP capabilities:
 *  server: logging, completions, tasks, experimental, resources
 *  client features used when the client supports them: sampling, elicitation, roots
 */
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { completable } from "@modelcontextprotocol/sdk/server/completable.js";
import { z } from "zod";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";
import { turath, getSection, getCatalog, byId, normalizeArabic, TurathError, log } from "./client.js";
import { text, fail, run, id, readOnly } from "./util.js";

type Level = "debug" | "info" | "notice" | "warning" | "error";

/** Logging capability: sends notifications/message to the client (ignored if not connected). */
export async function mcpLog(server: McpServer, level: Level, data: unknown) {
  try {
    await server.server.sendLoggingMessage({ level, logger: "turath", data });
  } catch {
    /* not connected yet or client filtered it */
  }
}

const catList = async () => {
  const cats = await getSection("categories");
  return (Array.isArray(cats) ? cats : Object.values(cats)) as any[];
};

export function registerAdvanced(server: McpServer) {
  const caps = () => server.server.getClientCapabilities() ?? {};

  // ---------- Resources (+ completions on the template variables) ----------
  server.registerResource(
    "categories",
    "turath://categories",
    { title: "Turath categories", description: "All categories with book counts", mimeType: "application/json" },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify((await catList()).map((c) => ({ id: c.id, name: c.name, book_count: c.books?.length ?? 0 })), null, 2),
        },
      ],
    })
  );

  server.registerResource(
    "category",
    new ResourceTemplate("turath://category/{category_id}", {
      list: async () => ({
        resources: (await catList()).map((c) => ({ uri: `turath://category/${c.id}`, name: c.name, mimeType: "application/json" })),
      }),
      complete: {
        category_id: async (v) =>
          (await catList())
            .filter((c) => String(c.id).startsWith(v) || normalizeArabic(c.name).includes(normalizeArabic(v)))
            .map((c) => String(c.id))
            .slice(0, 20),
      },
    }),
    { title: "Turath category", description: "A category and its book ids", mimeType: "application/json" },
    async (uri, { category_id }) => {
      const cat = byId(await getSection("categories"), String(category_id));
      if (!cat) throw new TurathError(`Category ${category_id} not found`);
      return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(cat, null, 2) }] };
    }
  );

  server.registerResource(
    "book",
    new ResourceTemplate("turath://book/{book_id}", { list: undefined }),
    { title: "Turath book metadata", description: "Metadata and table of contents of a book", mimeType: "application/json" },
    async (uri, { book_id }) => ({
      contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(await turath.book(Number(book_id)), null, 2) }],
    })
  );

  server.registerResource(
    "page",
    new ResourceTemplate("turath://book/{book_id}/page/{page}", { list: undefined }),
    { title: "Turath book page", description: "Text of a single book page", mimeType: "application/json" },
    async (uri, { book_id, page }) => ({
      contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(await turath.page(Number(book_id), Number(page)), null, 2) }],
    })
  );

  // ---------- Completions on prompt arguments ----------
  server.registerPrompt(
    "explore_category",
    {
      title: "Explore a category",
      description: "Browse a Turath category and recommend where to start reading.",
      argsSchema: {
        category: completable(z.string().describe("Category id or name"), async (v) =>
          (await catList())
            .filter((c) => normalizeArabic(c.name).includes(normalizeArabic(v ?? "")) || String(c.id).startsWith(v ?? ""))
            .map((c) => c.name)
            .slice(0, 20)
        ),
      },
    },
    ({ category }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `Find the Turath category "${category}" (turath_find_in_catalog with kind=categories, then turath_get_category). Present its most notable books and authors and suggest a reading path.`,
          },
        },
      ],
    })
  );

  // ---------- Sampling: ask the client's model to summarize a page ----------
  server.registerTool(
    "turath_summarize_page",
    {
      title: "Summarize a book page (uses client sampling)",
      description: "Fetches a page and asks the client's own model to summarize it. Requires a client with sampling support.",
      inputSchema: { book_id: id("Book ID"), page: id("Page number"), language: z.string().optional().describe("Summary language (default: Arabic)") },
      annotations: readOnly,
    },
    ({ book_id, page, language }) =>
      run(async () => {
        if (!caps().sampling) throw new TurathError("This client does not support sampling; use turath_get_page instead.");
        const p = await turath.page(book_id, page);
        const res = await server.server.createMessage({
          messages: [{ role: "user", content: { type: "text", text: `Summarize this page in ${language ?? "Arabic"}, quoting key phrases exactly:\n\n${JSON.stringify(p).slice(0, 12000)}` } }],
          systemPrompt: "You are a careful assistant for classical Islamic texts. Do not add claims that are not in the text.",
          maxTokens: 600,
        });
        return res.content.type === "text" ? res.content.text : "(non-text response)";
      })
  );

  // ---------- Elicitation: confirm before pulling a whole book ----------
  server.registerTool(
    "turath_get_book_file",
    {
      title: "Get static book file",
      description: "Fetch the static JSON of a whole book (large). Asks for confirmation if the client supports elicitation. Output is truncated.",
      inputSchema: { book_id: id("Book ID") },
      annotations: readOnly,
    },
    ({ book_id }) =>
      run(async () => {
        if (caps().elicitation) {
          const r = await server.server.elicitInput({
            message: `Download the full file of book ${book_id}? It can be several MB.`,
            requestedSchema: { type: "object", properties: { confirm: { type: "boolean", title: "Download", default: true } }, required: ["confirm"] },
          });
          if (r.action !== "accept" || !r.content?.confirm) return "Cancelled by user.";
        }
        return turath.bookFile(book_id);
      })
  );

  // ---------- Roots: export pages inside a root folder the client exposed ----------
  server.registerTool(
    "turath_export_pages",
    {
      title: "Export pages to a markdown file",
      description: "Saves a page range as a .md file in a turath-exports folder: inside the client root if shared, otherwise TURATH_EXPORT_DIR, otherwise the home directory.",
      inputSchema: { book_id: id("Book ID"), from_page: id("First page"), to_page: id("Last page (max 50 pages)") },
    },
    ({ book_id, from_page, to_page }) =>
      run(async () => {
        // 1) a file:// root shared by the client, 2) TURATH_EXPORT_DIR env var, 3) ~/turath-exports
        let base: string | undefined;
        let source = "default";
        if (caps().roots) {
          try {
            const { roots } = await server.server.listRoots();
            const root = roots.find((r) => r.uri.startsWith("file://"));
            if (root) {
              base = fileURLToPath(root.uri);
              source = "client root";
            }
          } catch (e) {
            log("listRoots failed:", (e as Error).message);
          }
        }
        if (!base && process.env.TURATH_EXPORT_DIR) {
          base = process.env.TURATH_EXPORT_DIR;
          source = "TURATH_EXPORT_DIR";
        }
        const dir = base ? path.join(base, "turath-exports") : path.join(os.homedir(), "turath-exports");
        const end = Math.min(to_page, from_page + 49);
        let md = `# Turath book ${book_id} — pages ${from_page}-${end}\n\n`;
        for (let n = from_page; n <= end; n++) {
          const p = await turath.page(book_id, n);
          md += `## Page ${n}\n\n${typeof p?.text === "string" ? p.text : JSON.stringify(p)}\n\n`;
        }
        await mkdir(dir, { recursive: true });
        const file = path.join(dir, `book-${book_id}-${from_page}-${end}.md`);
        await writeFile(file, md, "utf8");
        await mcpLog(server, "info", `exported ${file}`);
        return { saved: file, pages: end - from_page + 1, folder_source: source };
      })
  );

  // ---------- Tasks (experimental): long-running page fetch ----------
  server.experimental.tasks.registerToolTask(
    "turath_fetch_pages_task",
    {
      title: "Fetch many pages (task)",
      description: "Fetches up to 100 consecutive pages as a background task; poll with tasks/get and read with tasks/result.",
      inputSchema: { book_id: id("Book ID"), from_page: id("First page"), to_page: id("Last page (max 100 pages)") },
      execution: { taskSupport: "required" },
    },
    {
      async createTask({ book_id, from_page, to_page }, extra) {
        const task = await extra.taskStore.createTask({ ttl: 10 * 60_000, pollInterval: 1000 });
        const end = Math.min(to_page, from_page + 99);
        (async () => {
          try {
            const pages: unknown[] = [];
            for (let n = from_page; n <= end; n++) {
              pages.push({ page: n, ...(await turath.page(book_id, n)) });
              if ((n - from_page) % 10 === 0)
                await extra.taskStore.updateTaskStatus(task.taskId, "working", `fetched ${n - from_page + 1}/${end - from_page + 1}`);
            }
            await extra.taskStore.storeTaskResult(task.taskId, "completed", text(pages));
          } catch (e) {
            log("task failed:", e);
            await extra.taskStore.storeTaskResult(task.taskId, "failed", fail(e));
          }
        })();
        return { task };
      },
      async getTask(_args, extra) {
        return await extra.taskStore.getTask(extra.taskId);
      },
      async getTaskResult(_args, extra) {
        return (await extra.taskStore.getTaskResult(extra.taskId)) as any;
      },
    }
  );
}

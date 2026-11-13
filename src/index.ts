#!/usr/bin/env node
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { turath, getCatalog, searchSection, TurathError, log } from "./client.js";

const server = new McpServer({ name: "turath", version: "1.0.0" });

const MAX_CHARS = 30_000;
const text = (data: unknown) => {
  let s = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  if (s.length > MAX_CHARS) s = s.slice(0, MAX_CHARS) + "\n…[truncated]";
  return { content: [{ type: "text" as const, text: s }] };
};
const fail = (e: unknown) => ({
  isError: true,
  content: [{ type: "text" as const, text: e instanceof TurathError ? e.message : `Unexpected error: ${(e as Error).message}` }],
});
const run = async <T>(fn: () => Promise<T>) => {
  try {
    return text(await fn());
  } catch (e) {
    log("tool error:", e);
    return fail(e);
  }
};

const id = (what: string) => z.number().int().positive().describe(what);
const readOnly = { readOnlyHint: true, openWorldHint: true } as const;

server.registerTool(
  "turath_search",
  {
    title: "Search Turath",
    description: "Full-text search across the Turath Islamic library. Arabic queries work best.",
    inputSchema: {
      query: z.string().min(1).describe("Arabic search text"),
      page: z.number().int().min(1).optional().describe("Result page (default 1)"),
      precision: z.number().int().min(1).max(3).optional().describe("Match precision (default 2)"),
    },
    annotations: readOnly,
  },
  ({ query, page, precision }) => run(() => turath.search(query, { page, precision }))
);

server.registerTool(
  "turath_get_page",
  {
    title: "Get book page",
    description: "Fetch the text of one page of a book.",
    inputSchema: { book_id: id("Book ID"), page: id("Page number") },
    annotations: readOnly,
  },
  ({ book_id, page }) => run(() => turath.page(book_id, page))
);

server.registerTool(
  "turath_get_pages",
  {
    title: "Get a range of pages",
    description: "Fetch up to 10 consecutive pages of a book in one call.",
    inputSchema: {
      book_id: id("Book ID"),
      from_page: id("First page"),
      to_page: id("Last page (max 10 pages from from_page)"),
    },
    annotations: readOnly,
  },
  ({ book_id, from_page, to_page }) =>
    run(async () => {
      const end = Math.min(to_page, from_page + 9);
      const nums = Array.from({ length: Math.max(0, end - from_page + 1) }, (_, i) => from_page + i);
      const pages = await Promise.all(nums.map((n) => turath.page(book_id, n).then((p) => ({ page: n, ...p }))));
      return pages;
    })
);

server.registerTool(
  "turath_get_book",
  {
    title: "Get book info",
    description: "Book metadata, optionally with its table of contents (indexes).",
    inputSchema: {
      book_id: id("Book ID"),
      include_indexes: z.boolean().optional().describe("Include table of contents (default true)"),
    },
    annotations: readOnly,
  },
  ({ book_id, include_indexes }) => run(() => turath.book(book_id, include_indexes ?? true))
);

server.registerTool(
  "turath_get_author",
  {
    title: "Get author details",
    description: "Biographical details for an author.",
    inputSchema: { author_id: id("Author ID") },
    annotations: readOnly,
  },
  ({ author_id }) => run(() => turath.author(author_id))
);

server.registerTool(
  "turath_list_categories",
  {
    title: "List categories",
    description: "List book categories from the Turath catalog.",
    inputSchema: {},
    annotations: readOnly,
  },
  () => run(async () => (await getCatalog()).categories ?? (await turath.category()))
);

server.registerTool(
  "turath_find_in_catalog",
  {
    title: "Find books or authors by name",
    description: "Search the Turath catalog index (data-v3.json) by name to look up book or author IDs.",
    inputSchema: {
      kind: z.enum(["books", "authors", "categories"]).describe("Which catalog section to search"),
      query: z.string().describe("Name text, e.g. a title or author name (empty returns the first entries)"),
      limit: z.number().int().min(1).max(50).optional().describe("Max results (default 20)"),
    },
    annotations: readOnly,
  },
  ({ kind, query, limit }) =>
    run(async () => searchSection((await getCatalog())[kind], query, limit ?? 20))
);

server.registerTool(
  "turath_get_book_file",
  {
    title: "Get static book file",
    description: "Fetch the static JSON file of a whole book (can be large; output is truncated).",
    inputSchema: { book_id: id("Book ID") },
    annotations: readOnly,
  },
  ({ book_id }) => run(() => turath.bookFile(book_id))
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

server.registerPrompt(
  "research_topic",
  {
    title: "Research a topic in Turath",
    description: "Search Turath and summarize findings with book and page citations.",
    argsSchema: { topic: z.string().describe("Topic or phrase (Arabic preferred)") },
  },
  ({ topic }) => ({
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text: `Use turath_search to research: "${topic}". Open the most relevant pages with turath_get_page, then summarize in the user's language, citing book title, author and page number for every claim. Quote Arabic text exactly.`,
        },
      },
    ],
  })
);

async function main() {
  await server.connect(new StdioServerTransport());
  log("running on stdio");
}
main().catch((e) => {
  log("fatal:", e);
  process.exit(1);
});

#!/usr/bin/env node
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { turath, getCatalog, getSection, byId, resolveBooks, searchSection, TurathError, log } from "./client.js";
const server = new McpServer({ name: "turath", version: "1.0.0" });
const MAX_CHARS = 30_000;
const text = (data) => {
    let s = typeof data === "string" ? data : JSON.stringify(data, null, 2);
    if (s.length > MAX_CHARS)
        s = s.slice(0, MAX_CHARS) + "\n…[truncated]";
    return { content: [{ type: "text", text: s }] };
};
const fail = (e) => ({
    isError: true,
    content: [{ type: "text", text: e instanceof TurathError ? e.message : `Unexpected error: ${e.message}` }],
});
const run = async (fn) => {
    try {
        return text(await fn());
    }
    catch (e) {
        log("tool error:", e);
        return fail(e);
    }
};
const id = (what) => z.number().int().positive().describe(what);
const readOnly = { readOnlyHint: true, openWorldHint: true };
server.registerTool("turath_search", {
    title: "Search Turath",
    description: "Full-text search across the Turath Islamic library. Arabic queries work best.",
    inputSchema: {
        query: z.string().min(1).describe("Arabic search text"),
        page: z.number().int().min(1).optional().describe("Result page (default 1)"),
        precision: z.number().int().min(1).max(3).optional().describe("Match precision (default 2)"),
    },
    annotations: readOnly,
}, ({ query, page, precision }) => run(() => turath.search(query, { page, precision })));
server.registerTool("turath_get_page", {
    title: "Get book page",
    description: "Fetch the text of one page of a book.",
    inputSchema: { book_id: id("Book ID"), page: id("Page number") },
    annotations: readOnly,
}, ({ book_id, page }) => run(() => turath.page(book_id, page)));
server.registerTool("turath_get_pages", {
    title: "Get a range of pages",
    description: "Fetch up to 10 consecutive pages of a book in one call.",
    inputSchema: {
        book_id: id("Book ID"),
        from_page: id("First page"),
        to_page: id("Last page (max 10 pages from from_page)"),
    },
    annotations: readOnly,
}, ({ book_id, from_page, to_page }) => run(async () => {
    const end = Math.min(to_page, from_page + 9);
    const nums = Array.from({ length: Math.max(0, end - from_page + 1) }, (_, i) => from_page + i);
    const pages = await Promise.all(nums.map((n) => turath.page(book_id, n).then((p) => ({ page: n, ...p }))));
    return pages;
}));
server.registerTool("turath_get_book", {
    title: "Get book info",
    description: "Book metadata, optionally with its table of contents (indexes).",
    inputSchema: {
        book_id: id("Book ID"),
        include_indexes: z.boolean().optional().describe("Include table of contents (default true)"),
    },
    annotations: readOnly,
}, ({ book_id, include_indexes }) => run(() => turath.book(book_id, include_indexes ?? true)));
server.registerTool("turath_get_author", {
    title: "Get author details",
    description: "Author details: name, death year and the ids of their books (from the Turath catalog), merged with live details from the author API when available.",
    inputSchema: {
        author_id: id("Author ID"),
        include_books: z.boolean().optional().describe("Resolve the author's books to catalog entries (default false: ids only)"),
        limit: z.number().int().min(1).max(200).optional().describe("Max books when include_books is true (default 50)"),
        offset: z.number().int().min(0).optional().describe("Books offset (default 0)"),
    },
    annotations: readOnly,
}, ({ author_id, include_books, limit, offset }) => run(async () => {
    const cat = byId(await getSection("authors"), author_id);
    const live = await turath.author(author_id).catch((e) => {
        log("author API failed, using catalog only:", e.message);
        return undefined;
    });
    if (!cat && !live)
        throw new TurathError(`Author ${author_id} not found`);
    const bookIds = cat?.books ?? [];
    const out = { ...(cat ?? { id: author_id }), books: undefined, book_count: bookIds.length, details: live };
    if (include_books)
        out.books = resolveBooks(bookIds, (await getCatalog()).books, offset ?? 0, limit ?? 50);
    else
        out.book_ids = bookIds;
    return out;
}));
server.registerTool("turath_list_categories", {
    title: "List categories",
    description: "List all Turath book categories (id, name, number of books). Use turath_get_category for one category.",
    inputSchema: {},
    annotations: readOnly,
}, () => run(async () => {
    const cats = await getSection("categories");
    const list = (Array.isArray(cats) ? cats : Object.values(cats));
    return list.map((c) => ({ id: c.id, name: c.name, book_count: c.books?.length ?? 0 }));
}));
server.registerTool("turath_get_category", {
    title: "Get category by ID",
    description: "One category with its books. Books are paged; use offset/limit to walk large categories.",
    inputSchema: {
        category_id: id("Category ID (see turath_list_categories)"),
        include_books: z.boolean().optional().describe("Resolve books to catalog entries (default true; false returns ids only)"),
        limit: z.number().int().min(1).max(200).optional().describe("Max books (default 50)"),
        offset: z.number().int().min(0).optional().describe("Books offset (default 0)"),
    },
    annotations: readOnly,
}, ({ category_id, include_books, limit, offset }) => run(async () => {
    const cat = byId(await getSection("categories"), category_id);
    if (!cat)
        throw new TurathError(`Category ${category_id} not found. Use turath_list_categories.`);
    const ids = cat.books ?? [];
    const lim = limit ?? 50;
    const off = offset ?? 0;
    const base = { id: cat.id, name: cat.name, book_count: ids.length, offset: off, limit: lim };
    if (include_books === false)
        return { ...base, book_ids: ids.slice(off, off + lim) };
    return { ...base, books: resolveBooks(ids, (await getCatalog()).books, off, lim) };
}));
server.registerTool("turath_find_in_catalog", {
    title: "Find books, authors or categories by name",
    description: "Search the Turath catalog (data-v3.json) by name; Arabic diacritics and letter variants are ignored.",
    inputSchema: {
        kind: z.enum(["books", "authors", "categories"]).describe("Which catalog section to search"),
        query: z.string().describe("Name text (empty returns the first entries)"),
        limit: z.number().int().min(1).max(50).optional().describe("Max results (default 20)"),
    },
    annotations: readOnly,
}, ({ kind, query, limit }) => run(async () => {
    const r = searchSection(await getSection(kind), query, limit ?? 20);
    // Keep results compact: drop long id arrays, report their size instead.
    return {
        total: r.total,
        items: r.items.map((x) => {
            const { books, ...rest } = x;
            return Array.isArray(books) ? { ...rest, book_count: books.length } : x;
        }),
    };
}));
server.registerTool("turath_get_book_file", {
    title: "Get static book file",
    description: "Fetch the static JSON file of a whole book (can be large; output is truncated).",
    inputSchema: { book_id: id("Book ID") },
    annotations: readOnly,
}, ({ book_id }) => run(() => turath.bookFile(book_id)));
server.registerResource("book", new ResourceTemplate("turath://book/{book_id}", { list: undefined }), { title: "Turath book metadata", description: "Metadata and table of contents of a book", mimeType: "application/json" }, async (uri, { book_id }) => ({
    contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(await turath.book(Number(book_id)), null, 2) }],
}));
server.registerResource("page", new ResourceTemplate("turath://book/{book_id}/page/{page}", { list: undefined }), { title: "Turath book page", description: "Text of a single book page", mimeType: "application/json" }, async (uri, { book_id, page }) => ({
    contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(await turath.page(Number(book_id), Number(page)), null, 2) }],
}));
server.registerPrompt("research_topic", {
    title: "Research a topic in Turath",
    description: "Search Turath and summarize findings with book and page citations.",
    argsSchema: { topic: z.string().describe("Topic or phrase (Arabic preferred)") },
}, ({ topic }) => ({
    messages: [
        {
            role: "user",
            content: {
                type: "text",
                text: `Use turath_search to research: "${topic}". Open the most relevant pages with turath_get_page, then summarize in the user's language, citing book title, author and page number for every claim. Quote Arabic text exactly.`,
            },
        },
    ],
}));
async function main() {
    await server.connect(new StdioServerTransport());
    log("running on stdio");
}
main().catch((e) => {
    log("fatal:", e);
    process.exit(1);
});

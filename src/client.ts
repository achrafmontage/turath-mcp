/** Thin HTTP client for turath.io with timeout, retry and a cached catalog. */

const API = "https://api.turath.io";
const FILES = "https://files.turath.io";
const VER = "3";
const TIMEOUT_MS = 20_000;
const CATALOG_TTL_MS = 60 * 60 * 1000;

export class TurathError extends Error {}

export const log = (...a: unknown[]) => console.error("[turath-mcp]", ...a); // stderr only (stdio safe)

async function getJson(url: string, retries = 2): Promise<any> {
  let last: unknown;
  for (let i = 0; i <= retries; i++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(url, { signal: ctrl.signal, headers: { accept: "application/json" } });
      if (!res.ok) {
        if (res.status >= 400 && res.status < 500) throw new TurathError(`turath.io returned HTTP ${res.status} for ${url}`);
        throw new Error(`HTTP ${res.status}`);
      }
      return await res.json();
    } catch (e) {
      if (e instanceof TurathError) throw e;
      last = e;
      log(`attempt ${i + 1} failed for ${url}:`, (e as Error).message);
      await new Promise((r) => setTimeout(r, 400 * (i + 1)));
    } finally {
      clearTimeout(t);
    }
  }
  throw new TurathError(`Request failed: ${(last as Error)?.message ?? last}`);
}

const qs = (p: Record<string, string | number | undefined>) =>
  new URLSearchParams(
    Object.entries(p).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)])
  ).toString();

export const turath = {
  page: (bookId: number, page: number) =>
    getJson(`${API}/page?${qs({ book_id: bookId, pg: page, ver: VER })}`),

  book: (bookId: number, includeIndexes = true) =>
    getJson(`${API}/book?${qs({ id: bookId, include: includeIndexes ? "indexes" : undefined, ver: VER })}`),

  author: (authorId: number) => getJson(`${API}/author?${qs({ id: authorId, ver: VER })}`),

  search: (q: string, opts: { page?: number; precision?: number; nonAuthor?: boolean } = {}) =>
    getJson(
      `${API}/search?${qs({
        q,
        ver: VER,
        non_author: opts.nonAuthor === false ? undefined : 1,
        precision: opts.precision ?? 2,
        page: opts.page,
      })}`
    ),

  bookFile: (bookId: number) => getJson(`${FILES}/books-v3/${bookId}.json`),
};

let catalog: { at: number; data: any } | null = null;

/** Full index (categories, authors, books), cached in memory for an hour. */
export async function getCatalog(): Promise<any> {
  if (catalog && Date.now() - catalog.at < CATALOG_TTL_MS) return catalog.data;
  const data = await getJson(`${FILES}/data-v3.json`);
  catalog = { at: Date.now(), data };
  return data;
}

/** Strip Arabic diacritics/tatweel and unify letter variants for matching. */
export function normalizeArabic(s: string): string {
  return s
    .replace(/[\u064B-\u065F\u0670\u0640]/g, "")
    .replace(/[إأآٱ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .toLowerCase();
}

/** Flatten a catalog section (array or id-keyed object) into records and filter by text. */
export function searchSection(section: any, query: string, limit: number): { total: number; items: any[] } {
  if (!section) return { total: 0, items: [] };
  const records: any[] = Array.isArray(section)
    ? section.map((v, i) => (v && typeof v === "object" && !Array.isArray(v) ? v : { id: i, value: v }))
    : Object.entries(section).map(([k, v]) =>
        v && typeof v === "object" && !Array.isArray(v) ? { id: k, ...(v as object) } : { id: k, value: v }
      );
  const needle = normalizeArabic(query.trim());
  const matched = needle ? records.filter((r) => normalizeArabic(JSON.stringify(r)).includes(needle)) : records;
  return { total: matched.length, items: matched.slice(0, limit) };
}

/** Catalog layout of data-v3.json: { cats: {id:{id,name,books[]}}, authors: {id:{id,name,death,books[]}}, books: {...} } */
export type CatalogKind = "categories" | "authors" | "books";
const SECTION: Record<CatalogKind, string> = { categories: "cats", authors: "authors", books: "books" };

export async function getSection(kind: CatalogKind): Promise<any> {
  const data = await getCatalog();
  const section = data[SECTION[kind]];
  if (!section) throw new TurathError(`Catalog section "${SECTION[kind]}" not found in data-v3.json`);
  return section;
}

/** Look up one record by id from a catalog section (object keyed by id, or array of records). */
export function byId(section: any, id: number | string): any | undefined {
  if (!section) return undefined;
  if (Array.isArray(section)) return section.find((r) => r && String(r.id) === String(id));
  return section[String(id)];
}

/** Turn a catalog book record into a compact, readable entry. */
export function briefBook(rec: any, id: number | string): any {
  if (rec === undefined) return { id: Number(id) };
  if (rec && typeof rec === "object" && !Array.isArray(rec)) return { id: Number(id), ...rec };
  return { id: Number(id), data: rec };
}

/** Resolve a list of book ids against the catalog books section, paged. */
export function resolveBooks(ids: number[], booksSection: any, offset: number, limit: number) {
  return ids.slice(offset, offset + limit).map((id) => briefBook(byId(booksSection, id), id));
}

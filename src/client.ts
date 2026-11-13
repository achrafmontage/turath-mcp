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

  category: (categoryId?: number) => getJson(`${API}/category?${qs({ id: categoryId, ver: VER })}`),

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

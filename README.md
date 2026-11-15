# turath-mcp

An MCP (Model Context Protocol) server for [turath.io](https://turath.io) — search the Islamic library, read book pages, and look up books, authors and categories from Claude or any MCP client.

No download or build needed. Requires Node.js 18+.

## Quick start

### Claude Desktop
Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "turath": {
      "command": "npx",
      "args": ["-y", "github:USERNAME/turath-mcp"]
    }
  }
}
```

### Claude Code
```bash
claude mcp add turath -- npx -y github:USERNAME/turath-mcp
```

### Cursor / other clients
Use the same command: `npx -y github:USERNAME/turath-mcp`

> Once published to npm, replace `github:USERNAME/turath-mcp` with `turath-mcp`.

## Tools

| Tool | Description |
|---|---|
| `turath_search` | Full-text search across the library |
| `turath_get_page` | Text of one book page |
| `turath_get_pages` | Up to 10 consecutive pages |
| `turath_get_book` | Book metadata and table of contents |
| `turath_get_author` | Author details |
| `turath_list_categories` | Book categories |
| `turath_find_in_catalog` | Find book/author/category IDs by name |
| `turath_get_category` | One category with its books (paged) |
| `turath_get_book_file` | Static JSON of a whole book (asks for confirmation via elicitation) |
| `turath_summarize_page` | Summarize a page with the client model (sampling) |
| `turath_export_pages` | Save pages as .md inside the client's root folder (roots) |
| `turath_fetch_pages_task` | Fetch up to 100 pages as a background task (tasks) |

**Resources:** `turath://categories`, `turath://category/{id}`, `turath://book/{id}`, `turath://book/{id}/page/{page}`
**Prompts:** `research_topic`, `explore_category` (with argument completion)

## MCP capabilities
Server: tools, resources, prompts, logging, completions, tasks (experimental), experimental (`turath/arabic-normalization`).
Client features used when available: roots, sampling, elicitation (each tool degrades with a clear message if the client lacks it).

## Development
```bash
npm install
npm run build
npm run inspect   # opens MCP Inspector
```
`build/` is committed so `npx github:...` works instantly; run `npm run build` before committing source changes.

## Disclaimer
Unofficial project, not affiliated with turath.io. Content belongs to its respective owners; please respect turath.io's terms of use.

## License
MIT

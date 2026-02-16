# Dump (spec v0.1)

Minimal Tauri + React note capture app with:

- flat markdown note storage in `~/dump` by default
- YAML frontmatter (`id`, `created`, `tags`)
- `.dump-index.json` rebuild on launch/save
- recent + related notes list under a single editor column
- slash commands and inline tag input
- `Cmd+Enter` save, `Escape` clear, `Cmd+T` focus tag input

## Local development

```bash
npm install
npm run dev
```

Build web frontend:

```bash
npm run build
```

> Note: Tauri desktop builds on Linux require WebKit/GTK prerequisites (`glib/webkit2gtk`).

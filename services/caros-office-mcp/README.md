# caros-office-mcp

A stdio **MCP server** giving Caros full **Word / Excel / PowerPoint** automation —
read, create, and edit `.docx` / `.xlsx` / `.pptx`. It complements the in-process Rust
tools in `crates/goose-mcp/src/computercontroller/` (docx-rs / umya / lopdf), which stay
for lightweight headless ops; this server adds **PowerPoint** and deeper Word/Excel.

## Tools

| Tool | Purpose |
|---|---|
| `docx_read(path)` | extract all text |
| `docx_create(path, paragraphs, title?)` | new document |
| `docx_append(path, paragraphs)` | append to existing |
| `xlsx_read(path, sheet?)` | read rows |
| `xlsx_write(path, rows, sheet)` | new workbook |
| `xlsx_set_cell(path, cell, value, sheet?)` | edit one cell |
| `pptx_read(path)` | read slide text |
| `pptx_create(path, slides)` | new deck (title + bullets per slide) |

## Run locally

```bash
pip install -r requirements.txt
python server.py        # speaks MCP over stdio
```

## Register as a bundled, default-enabled extension (the remaining Rust step)

A Python server is an **external process**, so it is **NOT** a `builtin!`
(`BUILTIN_EXTENSIONS` only supports in-process Rust handlers). Wire it as an
`ExtensionConfig::Stdio` seeded enabled-by-default via the bundled-extension path in
`crates/goose/src/config/migrations.rs` + the bundled-extensions manifest validated by
`crates/goose/src/agents/validate_extensions.rs`:

```jsonc
{
  "name": "office",
  "type": "stdio",
  "cmd": "<bundled python>",          // or "python3" for dev
  "args": ["-m", "caros_office_mcp.server"],   // or an absolute path to server.py
  "bundled": true,
  "enabled": true
}
```

**Packaging:** ship `server.py` + a frozen interpreter (PyInstaller, or an embedded Python
under `ui/desktop/forge.config.ts` `extraResource`); resolve `cmd` to the bundled path on
desktop, falling back to system `python3` for CLI/dev. On Windows, install the optional
`pywin32` extra to add COM automation against an installed Office for full fidelity.

## Status

- ✅ Server implemented; `python -m py_compile server.py` passes (8 tools).
- ⬜ Rust registration (`migrations.rs` + bundled manifest) and desktop packaging — pending
  (needs `cargo build`, unavailable in the authoring environment).

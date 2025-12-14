# Obsidian Model Context Protocol Tools

A Model Context Protocol (MCP) server that allows MCP clients (Cursor, VSCode, Claude Desktop, etc.) to read and search any directory containing Markdown notes, such as an Obsidian vault.

This server exposes a rich, read-only toolkit of `obsidian_`-prefixed MCP tools for working with vault metadata (tags, links, frontmatter), filenames, and full-text content.

## Prerequisites

- Node.js (v18 or higher)
- npm (comes with Node.js)
- An Obsidian vault or directory containing Markdown files

## Installation

### 1. Clone the Repository

```bash
git clone https://github.com/dp-veritas/mcp-obsidian-tools.git
cd mcp-obsidian-tools
```

### 2. Install Dependencies

```bash
npm install
```

### 3. Build the Project

```bash
npm run build
```

This will compile the TypeScript code and create the `dist/` directory with the executable files.

## Configuration

After building, you need to add this server to your MCP client's configuration. The configuration format varies by client, but generally follows this pattern:

> **Quick Start:** See `example-mcp-config.json` for Cursor/VSCode format, or `example-claude-desktop-config.json` for Claude Desktop format.

### Configuration Format

Add an entry to your MCP client's configuration file (usually `mcpServers` or `mcp.servers`):

```json
{
  "mcpServers": {
    "obsidian": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-obsidian-tools/dist/index.js", "/path/to/your/vault"]
    }
  }
}
```

**Important:** Use absolute paths for both the server location and your vault path.

### Path Formats Supported

The vault path can be:
- **Absolute path**: `/Users/username/Documents/MyVault`
- **Relative path**: `./my-vault` (relative to current working directory)
- **Home directory shortcut**: `~/Documents/MyVault`

### Example Configurations

#### For Cursor

Add to your Cursor MCP settings file (location varies by OS):

```json
{
  "mcpServers": {
    "obsidian": {
      "command": "node",
      "args": ["/Users/username/path/to/mcp-obsidian-tools/dist/index.js", "/Users/username/Documents/MyVault"]
    }
  }
}
```

#### For VSCode

Add to your User Settings JSON (`Ctrl+Shift+P` → `Preferences: Open User Settings (JSON)`) or create `.vscode/mcp.json`:

```json
{
  "mcp": {
    "servers": {
      "obsidian": {
        "command": "node",
        "args": ["/Users/username/path/to/mcp-obsidian-tools/dist/index.js", "/Users/username/Documents/MyVault"]
      }
    }
  }
}
```

#### For Claude Desktop

Add to Claude Desktop's MCP configuration file (location varies by OS). Claude Desktop configs can include a `preferences` section:

```json
{
  "preferences": {
    "quickEntryShortcut": {
      "accelerator": "Alt+Space"
    }
  },
  "mcpServers": {
    "obsidian": {
      "command": "node",
      "args": ["/Users/username/path/to/mcp-obsidian-tools/dist/index.js", "/Users/username/Documents/MyVault"]
    }
  }
}
```

> **Note:** See `example-claude-desktop-config.json` for a complete Claude Desktop example. See `example-mcp-config.json` for Cursor/VSCode format.

### Global Installation (Optional)

If you prefer to install globally so you can use it from anywhere:

```bash
npm install -g .
```

Then configure with:

```json
{
  "mcpServers": {
    "obsidian": {
      "command": "mcp-obsidian-tools",
      "args": ["/path/to/your/vault"]
    }
  }
}
```

## Available Tools

Once configured, the following MCP tools will be available:

- **`obsidian_search_notes`**: Search for notes by filename (case-insensitive, supports simple regex / wildcards). Returns relative paths of matching `.md` files.

- **`obsidian_read_notes`**: Read the contents of multiple notes by relative path. Each note is returned with its path header; failures are reported per-note.

- **`obsidian_list_tags`**: Scan all Markdown files and list all tags (frontmatter `tags` and inline `#tags`) with occurrence counts. Optional `startsWith` filter.

- **`obsidian_notes_by_tag`**: Given one or more tag names, return all note paths that contain those tags (frontmatter or inline). Optional `match` of `"any"` or `"all"`.

- **`obsidian_get_frontmatter`**: Return parsed YAML frontmatter as JSON for a given note path (e.g. `author`, `tags`, `created`).

- **`obsidian_backlinks`**: Given a target note path or name, list all notes that link to it, via Obsidian wikilinks (`[[Note Name]]`) or markdown links (`[Display](path)`).

- **`obsidian_search_content`**: Full-text search inside note contents (not filenames). Supports simple wildcard patterns; can return just paths or snippets with context.

- **`obsidian_query`**: Natural-language query over the vault, with optional date filtering based on frontmatter dates (e.g. `created: YYYY-MM-DDTHH:MM:SS`).

- **`obsidian_count_files`**: Count the total number of markdown files in the vault or a specific subfolder. Returns total count and breakdown by immediate subfolders. Useful for understanding vault size and organization.

All tools are **read-only** and are strictly confined to the vault directory (and its real/symlinked path) via path validation.

### Example obsidian_query Prompts

- `Which of my entries concern the overton window?`
- `Show interview candidate notes I've logged from the last 6 months`
- `Any daily notes about board-related topics this month?`

## Troubleshooting

### Server Not Starting

- **Check paths**: Ensure both the server path and vault path are absolute paths
- **Verify build**: Make sure you ran `npm run build` and the `dist/` directory exists
- **Check Node.js**: Ensure Node.js v18+ is installed (`node --version`)

### Tools Not Appearing

- **Restart client**: After adding the configuration, restart your MCP client (Cursor/VSCode/Claude Desktop)
- **Check logs**: Look for error messages in your MCP client's logs
- **Verify vault path**: Ensure the vault path is correct and accessible

### Permission Errors

- **Check vault permissions**: Ensure you have read access to the vault directory
- **Check server permissions**: Ensure the `dist/index.js` file is executable (`chmod +x dist/index.js`)

## Development

To watch for changes during development:

```bash
npm run watch
```

## License

See [LICENSE](LICENSE) file for details.

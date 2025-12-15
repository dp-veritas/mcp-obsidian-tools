#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ToolSchema,
} from "@modelcontextprotocol/sdk/types.js"
import fs from "fs/promises"
import path from "path"
import os from "os"
import * as fsSync from "fs"
import { z } from "zod"
import { zodToJsonSchema } from "zod-to-json-schema"
import yaml from "js-yaml"

// Maximum number of search results to return
const SEARCH_LIMIT = 200
const CONTENT_SEARCH_LIMIT = 200

// Command line argument parsing
const args = process.argv.slice(2)
if (args.length === 0) {
  console.error("Usage: mcp-obsidian-tools <vault-directory>")
  process.exit(1)
}

// Normalize all paths consistently
function normalizePath(p: string): string {
  return path.normalize(p)
}

function expandHome(filepath: string): string {
  if (filepath.startsWith("~/") || filepath === "~") {
    return path.join(os.homedir(), filepath.slice(1))
  }
  return filepath
}

// Store allowed directories in normalized form
const initialDir   = normalizePath(path.resolve(expandHome(args[0])));
const canonicalDir = normalizePath(fsSync.realpathSync(initialDir));

const vaultDirectories =
  initialDir === canonicalDir
    ? [initialDir]                 // no symlink → single entry
    : [initialDir, canonicalDir];

// Validate that all directories exist and are accessible
await Promise.all(
  args.map(async (dir) => {
    try {
      const stats = await fs.stat(dir)
      if (!stats.isDirectory()) {
        console.error(`Error: ${dir} is not a directory`)
        process.exit(1)
      }
    } catch (error) {
      console.error(`Error accessing directory ${dir}:`, error)
      process.exit(1)
    }
  })
)

// Security utilities
async function validatePath(requestedPath: string): Promise<string> {
  // Ignore hidden files/directories starting with "."
  const pathParts = requestedPath.split(path.sep)
  if (pathParts.some((part) => part.startsWith("."))) {
    throw new Error("Access denied - hidden files/directories not allowed")
  }

  const expandedPath = expandHome(requestedPath)
  const absolute = path.isAbsolute(expandedPath)
    ? path.resolve(expandedPath)
    : path.resolve(process.cwd(), expandedPath)

  const normalizedRequested = normalizePath(absolute)

  // Check if path is within allowed directories
  const isAllowed = vaultDirectories.some((dir) =>
    normalizedRequested.startsWith(dir)
  )
  if (!isAllowed) {
    throw new Error(
      `Access denied - path outside allowed directories: ${absolute} not in ${vaultDirectories.join(
        ", "
      )}`
    )
  }

  // Handle symlinks by checking their real path
  try {
    const realPath = await fs.realpath(absolute)
    const normalizedReal = normalizePath(realPath)
    const isRealPathAllowed = vaultDirectories.some((dir) =>
      normalizedReal.startsWith(dir)
    )
    if (!isRealPathAllowed) {
      throw new Error(
        "Access denied - symlink target outside allowed directories"
      )
    }
    return realPath
  } catch (error) {
    // For new files that don't exist yet, verify parent directory
    const parentDir = path.dirname(absolute)
    try {
      const realParentPath = await fs.realpath(parentDir)
      const normalizedParent = normalizePath(realParentPath)
      const isParentAllowed = vaultDirectories.some((dir) =>
        normalizedParent.startsWith(dir)
      )
      if (!isParentAllowed) {
        throw new Error(
          "Access denied - parent directory outside allowed directories"
        )
      }
      return absolute
    } catch {
      throw new Error(`Parent directory does not exist: ${parentDir}`)
    }
  }
}

// Schema definitions
const ReadNotesArgsSchema = z.object({
  paths: z.array(z.string()),
  headersOnly: z.boolean().optional().describe("When true, return only markdown headings (lines starting with #), not full content. Useful for quickly getting titles and structure."),
})

const SearchNotesArgsSchema = z.object({
  query: z.string(),
})

const ObsidianListTagsArgsSchema = z.object({
  startsWith: z.string().optional(),
})

const ObsidianNotesByTagArgsSchema = z.object({
  tags: z.array(z.string()),
  match: z.enum(["any", "all"]).optional(),
})

const ObsidianGetFrontmatterArgsSchema = z.object({
  path: z.string(),
})

const ObsidianBacklinksArgsSchema = z.object({
  target: z.string(),
})

const ObsidianSearchContentArgsSchema = z.object({
  query: z.string(),
  maxResults: z.number().int().positive().optional(),
  includeContext: z.boolean().optional(),
})

const ObsidianQueryArgsSchema = z.object({
  query: z.string(),
  maxResults: z.number().int().positive().optional(),
})

const ObsidianCountFilesArgsSchema = z.object({
  folder: z.string().optional().describe("Optional subfolder path relative to vault root. If omitted, counts entire vault."),
  includeSubfolders: z.boolean().optional().describe("Whether to count files in subfolders. Defaults to true."),
  includeNames: z.boolean().optional().describe("Whether to include file names in the response. Defaults to false. When true, returns a list of file names along with the count."),
})

const ToolInputSchema = ToolSchema.shape.inputSchema
type ToolInput = z.infer<typeof ToolInputSchema>

// Server setup
const server = new Server(
  {
    name: "mcp-obsidian-tools",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
)

/**
 * Search for notes in the allowed directories that match the query.
 * @param query - The query to search for.
 * @returns An array of relative paths to the notes (from root) that match the query.
 */
async function searchNotes(query: string): Promise<string[]> {
  const results: string[] = []

  async function search(basePath: string, currentPath: string) {
    const entries = await fs.readdir(currentPath, { withFileTypes: true })

    for (const entry of entries) {
      const fullPath = path.join(currentPath, entry.name)

      try {
        // Validate each path before processing
        await validatePath(fullPath)

        let matches = entry.name.toLowerCase().includes(query.toLowerCase())
        try {
          matches =
            matches ||
            new RegExp(query.replace(/[*]/g, ".*"), "i").test(entry.name)
        } catch {
          // Ignore invalid regex
        }

        if (entry.name.endsWith(".md") && matches) {
          // Turn into relative path
          results.push(fullPath.replace(basePath, ""))
        }

        if (entry.isDirectory()) {
          await search(basePath, fullPath)
        }
      } catch (error) {
        // Skip invalid paths during search
        continue
      }
    }
  }

  await Promise.all(vaultDirectories.map((dir) => search(dir, dir)))
  return results
}

type Frontmatter = {
  author?: string
  tags?: string[] | string
  created?: string
  date?: string
  modified?: string
  "created-date"?: string
  [key: string]: unknown
}

type ParsedNote = {
  path: string
  frontmatter: Frontmatter | null
  content: string
}

async function readNote(relativePath: string): Promise<ParsedNote> {
  const base = vaultDirectories[0]
  const absolute = path.join(base, relativePath)
  const validPath = await validatePath(absolute)
  const content = await fs.readFile(validPath, "utf-8")

  const { frontmatter, body } = parseFrontmatter(content)
  return {
    path: relativePath,
    frontmatter,
    content: body,
  }
}

function parseFrontmatter(
  raw: string
): { frontmatter: Frontmatter | null; body: string } {
  if (!raw.startsWith("---")) {
    return { frontmatter: null, body: raw }
  }

  const fmMatch = raw.match(/^---\s*[\r\n]+([\s\S]*?)^[.-]{3}\s*$/m)
  if (!fmMatch) {
    // Fallback: try a more permissive pattern
    const altMatch = raw.match(/^---\s*[\r\n]+([\s\S]*?)\s*---\s*[\r\n]/)
    if (!altMatch) {
      return { frontmatter: null, body: raw }
    }
    const fmText = altMatch[1]
    const body = raw.slice(altMatch[0].length)
    try {
      const data = yaml.load(fmText) as Frontmatter | undefined
      return { frontmatter: data ?? null, body }
    } catch {
      return { frontmatter: null, body: raw }
    }
  }

  const fmText = fmMatch[1]
  const body = raw.slice(fmMatch[0].length)
  try {
    const data = yaml.load(fmText) as Frontmatter | undefined
    return { frontmatter: data ?? null, body }
  } catch {
    return { frontmatter: null, body: raw }
  }
}

function extractTagsFromFrontmatter(frontmatter: Frontmatter | null): string[] {
  if (!frontmatter || frontmatter.tags == null) {
    return []
  }
  if (Array.isArray(frontmatter.tags)) {
    return frontmatter.tags.map(String)
  }
  if (typeof frontmatter.tags === "string") {
    // support comma or space separated tags
    return frontmatter.tags
      .split(/[,\s]+/)
      .map((t) => t.trim())
      .filter((t) => t.length > 0)
  }
  return []
}

function extractInlineTags(content: string): string[] {
  const tags = new Set<string>()
  const lines = content.split(/\r?\n/)
  let inCodeBlock = false

  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed.startsWith("```") || trimmed.startsWith("~~~")) {
      inCodeBlock = !inCodeBlock
      continue
    }
    if (inCodeBlock) continue

    const regex = /(^|\s)#([A-Za-z0-9/_-]+)/g
    let match: RegExpExecArray | null
    while ((match = regex.exec(line)) !== null) {
      tags.add(match[2])
    }
  }

  return Array.from(tags)
}

function extractAllTags(note: ParsedNote): string[] {
  const frontmatterTags = extractTagsFromFrontmatter(note.frontmatter)
  const inlineTags = extractInlineTags(note.content)
  return Array.from(new Set([...frontmatterTags, ...inlineTags]))
}

function extractLinks(content: string): string[] {
  const links: string[] = []

  // Wiki links [[...]]
  const wikiRegex = /\[\[([^\]]+)\]\]/g
  let match: RegExpExecArray | null
  while ((match = wikiRegex.exec(content)) !== null) {
    const inner = match[1]
    const target = inner.split("|")[0].trim()
    if (target.length > 0) {
      links.push(target)
    }
  }

  // Markdown links [Text](path)
  const mdRegex = /\[[^\]]*?\]\(([^)]+)\)/g
  while ((match = mdRegex.exec(content)) !== null) {
    const target = match[1].trim()
    if (target.length > 0) {
      links.push(target)
    }
  }

  return links
}

function parseNoteDate(note: ParsedNote): Date | null {
  const fm = note.frontmatter
  const candidates: (string | undefined)[] = [
    fm?.created as string | undefined,
    fm?.date as string | undefined,
    fm?.modified as string | undefined,
    (fm && (fm["created-date"] as string | undefined)) || undefined,
  ]

  for (const value of candidates) {
    if (!value) continue
    const d = new Date(value)
    if (!isNaN(d.getTime())) {
      return d
    }
  }

  // Fallback: infer from Daily-style filename YYYY-MMM-DD
  const baseName = path.basename(note.path, path.extname(note.path))
  const dailyMatch = baseName.match(/^(\d{4})-([A-Za-z]{3})-(\d{2})/)
  if (dailyMatch) {
    const [_, year, monthStr, day] = dailyMatch
    const month = [
      "jan",
      "feb",
      "mar",
      "apr",
      "may",
      "jun",
      "jul",
      "aug",
      "sep",
      "oct",
      "nov",
      "dec",
    ].indexOf(monthStr.toLowerCase())
    if (month >= 0) {
      const d = new Date(
        Number(year),
        month,
        Number(day),
        0,
        0,
        0,
        0
      )
      if (!isNaN(d.getTime())) {
        return d
      }
    }
  }

  return null
}

type DateRange = { start: Date; end: Date }

function parseNaturalLanguageDateRange(query: string): {
  cleanedQuery: string
  range: DateRange | null
} {
  const lower = query.toLowerCase()
  const now = new Date()
  let start: Date | null = null
  let end: Date | null = null
  let cleaned = query

  function firstDayOfMonth(year: number, month: number): Date {
    return new Date(year, month, 1, 0, 0, 0, 0)
  }

  function lastDayOfMonth(year: number, month: number): Date {
    return new Date(year, month + 1, 0, 23, 59, 59, 999)
  }

  if (lower.includes("last month")) {
    const year = now.getMonth() === 0 ? now.getFullYear() - 1 : now.getFullYear()
    const month = (now.getMonth() + 11) % 12
    start = firstDayOfMonth(year, month)
    end = lastDayOfMonth(year, month)
    cleaned = cleaned.replace(/last month/gi, "").trim()
  } else if (lower.includes("this month")) {
    const year = now.getFullYear()
    const month = now.getMonth()
    start = firstDayOfMonth(year, month)
    end = lastDayOfMonth(year, month)
    cleaned = cleaned.replace(/this month/gi, "").trim()
  } else if (lower.includes("last week")) {
    const day = now.getDay() || 7
    const lastWeekEnd = new Date(now)
    lastWeekEnd.setDate(now.getDate() - day)
    lastWeekEnd.setHours(23, 59, 59, 999)
    const lastWeekStart = new Date(lastWeekEnd)
    lastWeekStart.setDate(lastWeekEnd.getDate() - 6)
    lastWeekStart.setHours(0, 0, 0, 0)
    start = lastWeekStart
    end = lastWeekEnd
    cleaned = cleaned.replace(/last week/gi, "").trim()
  } else if (lower.includes("this week")) {
    const day = now.getDay() || 7
    const weekStart = new Date(now)
    weekStart.setDate(now.getDate() - day + 1)
    weekStart.setHours(0, 0, 0, 0)
    const weekEnd = new Date(weekStart)
    weekEnd.setDate(weekStart.getDate() + 6)
    weekEnd.setHours(23, 59, 59, 999)
    start = weekStart
    end = weekEnd
    cleaned = cleaned.replace(/this week/gi, "").trim()
  } else if (lower.includes("yesterday")) {
    const d = new Date(now)
    d.setDate(now.getDate() - 1)
    start = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0)
    end = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999)
    cleaned = cleaned.replace(/yesterday/gi, "").trim()
  } else if (lower.includes("today")) {
    start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0)
    end = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate(),
      23,
      59,
      59,
      999
    )
    cleaned = cleaned.replace(/today/gi, "").trim()
  }

  if (start && end) {
    return { cleanedQuery: cleaned, range: { start, end } }
  }
  return { cleanedQuery: query, range: null }
}

function dateInRange(date: Date | null, range: DateRange | null): boolean {
  if (!range) return true
  if (!date) return false
  return date >= range.start && date <= range.end
}

function buildSearchRegex(query: string): RegExp | null {
  try {
    return new RegExp(query.replace(/[*]/g, ".*"), "i")
  } catch {
    return null
  }
}

function buildContentSnippet(
  content: string,
  index: number,
  length: number = 200
): string {
  const start = Math.max(0, index - 80)
  const end = Math.min(content.length, index + length)
  const prefix = start > 0 ? "…" : ""
  const suffix = end < content.length ? "…" : ""
  return prefix + content.slice(start, end).trim() + suffix
}

/**
 * Search for folders by name anywhere in the vault.
 * Returns an array of relative paths to matching folders.
 */
async function findFoldersByName(folderName: string): Promise<string[]> {
  const matches: string[] = []
  const lowerName = folderName.toLowerCase()

  for (const base of vaultDirectories) {
    const stack: string[] = [base]

    while (stack.length > 0) {
      const current = stack.pop()!
      let entries
      try {
        entries = await fs.readdir(current, { withFileTypes: true })
      } catch {
        continue
      }

      for (const entry of entries) {
        if (!entry.isDirectory()) continue

        const fullPath = path.join(current, entry.name)
        try {
          await validatePath(fullPath)
        } catch {
          continue
        }

        // Check if this folder matches the name (case-insensitive)
        if (entry.name.toLowerCase() === lowerName) {
          const relativePath = fullPath.replace(base, "").replace(/^[/\\]/, "")
          matches.push(relativePath)
        }

        // Continue searching subdirectories
        stack.push(fullPath)
      }
    }
  }

  return matches
}

// Tool handlers
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "obsidian_read_notes",
        description:
          "Read the contents of multiple notes within the Obsidian vault. " +
          "Each note's content is returned with its path as a reference. " +
          "Failed reads for individual notes won't stop the entire operation. " +
          "Set headersOnly=true to return only headings (lines starting with #) for quick title/structure extraction. " +
          "Reading too many at once may result in an error.",
        inputSchema: zodToJsonSchema(ReadNotesArgsSchema) as ToolInput,
      },
      {
        name: "obsidian_search_notes",
        description:
          "Searches for notes by filename within the Obsidian vault. " +
          "The search is case-insensitive and matches partial names. " +
          "Queries can also be a valid regex. Returns paths of the notes " +
          "that match the query.",
        inputSchema: zodToJsonSchema(SearchNotesArgsSchema) as ToolInput,
      },
      {
        name: "obsidian_list_tags",
        description:
          "Scan all Markdown notes in the Obsidian vault and list all tags " +
          "(from frontmatter and inline #tags) with occurrence counts.",
        inputSchema: zodToJsonSchema(
          ObsidianListTagsArgsSchema
        ) as ToolInput,
      },
      {
        name: "obsidian_notes_by_tag",
        description:
          "Given one or more tag names, return the list of note paths in the " +
          "Obsidian vault that contain those tags (frontmatter or inline).",
        inputSchema: zodToJsonSchema(
          ObsidianNotesByTagArgsSchema
        ) as ToolInput,
      },
      {
        name: "obsidian_get_frontmatter",
        description:
          "Return the parsed YAML frontmatter for a given note path in the " +
          "Obsidian vault as JSON.",
        inputSchema: zodToJsonSchema(
          ObsidianGetFrontmatterArgsSchema
        ) as ToolInput,
      },
      {
        name: "obsidian_backlinks",
        description:
          "Given a target note path or note name, list all notes in the " +
          "Obsidian vault that link to it (via wiki links or markdown links).",
        inputSchema: zodToJsonSchema(
          ObsidianBacklinksArgsSchema
        ) as ToolInput,
      },
      {
        name: "obsidian_search_content",
        description:
          "Search within note contents (not filenames) in the Obsidian vault " +
          "for a query string or simple wildcard pattern. Returns matching " +
          "note paths with snippets.",
        inputSchema: zodToJsonSchema(
          ObsidianSearchContentArgsSchema
        ) as ToolInput,
      },
      {
        name: "obsidian_query",
        description:
          "Execute a natural language query over the Obsidian vault, with " +
          "optional date filtering based on frontmatter (e.g. 'was there a " +
          "marketing sync last month'). Uses frontmatter dates and tags to " +
          "narrow results.",
        inputSchema: zodToJsonSchema(
          ObsidianQueryArgsSchema
        ) as ToolInput,
      },
      {
        name: "obsidian_count_files",
        description:
          "Count the total number of markdown files (.md) in the Obsidian vault " +
          "or a specific subfolder. Supports folder name lookup - if a folder like 'History 101' " +
          "isn't found at the root, automatically searches the entire vault for matching folders. " +
          "Returns the total count and a breakdown by immediate subfolders. " +
          "Set includeNames=true to also get a list of file names. " +
          "Useful for understanding vault size, organization, and listing files in a folder.",
        inputSchema: zodToJsonSchema(
          ObsidianCountFilesArgsSchema
        ) as ToolInput,
      },
    ],
  }
})

server.setRequestHandler(CallToolRequestSchema, async (request: any) => {
  try {
    const { name, arguments: args } = request.params

    switch (name) {
      case "obsidian_read_notes": {
        const parsed = ReadNotesArgsSchema.safeParse(args)
        if (!parsed.success) {
          throw new Error(
            `Invalid arguments for obsidian_read_notes: ${parsed.error}`
          )
        }
        const { headersOnly } = parsed.data
        const results = await Promise.all(
          parsed.data.paths.map(async (filePath: string) => {
            try {
              const validPath = await validatePath(
                path.join(vaultDirectories[0], filePath)
              )
              let content = await fs.readFile(validPath, "utf-8")
              if (headersOnly) {
                const hdrs = content.split("\n").filter(l => l.match(/^#+\s/)).join("\n")
                content = hdrs || "(no headings found)"
              }
              return `${filePath}:\n${content}\n`
            } catch (error) {
              const errorMessage =
                error instanceof Error ? error.message : String(error)
              return `${filePath}: Error - ${errorMessage}`
            }
          })
        )
        return {
          content: [{ type: "text", text: results.join("\n---\n") }],
        }
      }
      case "obsidian_search_notes": {
        const parsed = SearchNotesArgsSchema.safeParse(args)
        if (!parsed.success) {
          throw new Error(
            `Invalid arguments for obsidian_search_notes: ${parsed.error}`
          )
        }
        const results = await searchNotes(parsed.data.query)

        const limitedResults = results.slice(0, SEARCH_LIMIT)
        return {
          content: [
            {
              type: "text",
              text:
                (limitedResults.length > 0
                  ? limitedResults.join("\n")
                  : "No matches found") +
                (results.length > SEARCH_LIMIT
                  ? `\n\n... ${
                      results.length - SEARCH_LIMIT
                    } more results not shown.`
                  : ""),
            },
          ],
        }
      }
      case "obsidian_list_tags": {
        const parsed = ObsidianListTagsArgsSchema.safeParse(args)
        if (!parsed.success) {
          throw new Error(
            `Invalid arguments for obsidian_list_tags: ${parsed.error}`
          )
        }

        const tagCounts: Record<string, number> = {}

        for (const base of vaultDirectories) {
          const stack: string[] = [base]
          while (stack.length > 0) {
            const current = stack.pop() as string
            const entries = await fs.readdir(current, { withFileTypes: true })
            for (const entry of entries) {
              const fullPath = path.join(current, entry.name)
              try {
                await validatePath(fullPath)
              } catch {
                continue
              }
              if (entry.isDirectory()) {
                stack.push(fullPath)
              } else if (entry.isFile() && entry.name.endsWith(".md")) {
                const rel = fullPath.replace(base, "")
                const note = await readNote(rel)
                const tags = extractAllTags(note)
                for (const tag of tags) {
                  if (
                    parsed.data.startsWith &&
                    !tag.startsWith(parsed.data.startsWith)
                  ) {
                    continue
                  }
                  tagCounts[tag] = (tagCounts[tag] ?? 0) + 1
                }
              }
            }
          }
        }

        const lines = Object.entries(tagCounts)
          .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
          .map(([tag, count]) => `${tag}: ${count}`)

        return {
          content: [
            {
              type: "text",
              text:
                lines.length > 0
                  ? lines.join("\n")
                  : "No tags found in the Obsidian vault.",
            },
          ],
        }
      }
      case "obsidian_notes_by_tag": {
        const parsed = ObsidianNotesByTagArgsSchema.safeParse(args)
        if (!parsed.success) {
          throw new Error(
            `Invalid arguments for obsidian_notes_by_tag: ${parsed.error}`
          )
        }

        const requiredTags = parsed.data.tags
        const matchMode = parsed.data.match ?? "any"
        const matches: string[] = []

        for (const base of vaultDirectories) {
          const stack: string[] = [base]
          while (stack.length > 0) {
            const current = stack.pop() as string
            const entries = await fs.readdir(current, { withFileTypes: true })
            for (const entry of entries) {
              const fullPath = path.join(current, entry.name)
              try {
                await validatePath(fullPath)
              } catch {
                continue
              }
              if (entry.isDirectory()) {
                stack.push(fullPath)
              } else if (entry.isFile() && entry.name.endsWith(".md")) {
                const rel = fullPath.replace(base, "")
                const note = await readNote(rel)
                const tags = extractAllTags(note)
                if (tags.length === 0) continue
                const hasAll =
                  matchMode === "all"
                    ? requiredTags.every((t) => tags.includes(t))
                    : requiredTags.some((t) => tags.includes(t))
                if (hasAll) {
                  matches.push(rel)
                }
              }
            }
          }
        }

        return {
          content: [
            {
              type: "text",
              text:
                matches.length > 0
                  ? matches.join("\n")
                  : "No notes found with the specified tags.",
            },
          ],
        }
      }
      case "obsidian_get_frontmatter": {
        const parsed = ObsidianGetFrontmatterArgsSchema.safeParse(args)
        if (!parsed.success) {
          throw new Error(
            `Invalid arguments for obsidian_get_frontmatter: ${parsed.error}`
          )
        }
        const note = await readNote(parsed.data.path)
        if (!note.frontmatter) {
          return {
            content: [
              {
                type: "text",
                text: `No frontmatter found for ${parsed.data.path}`,
              },
            ],
          }
        }
        const pretty = JSON.stringify(note.frontmatter, null, 2)
        return {
          content: [
            {
              type: "text",
              text: `${parsed.data.path} frontmatter:\n${pretty}`,
            },
          ],
        }
      }
      case "obsidian_backlinks": {
        const parsed = ObsidianBacklinksArgsSchema.safeParse(args)
        if (!parsed.success) {
          throw new Error(
            `Invalid arguments for obsidian_backlinks: ${parsed.error}`
          )
        }

        const target = parsed.data.target
        const normalizedTarget = target.replace(/\\/g, "/")
        const targetBase = path
          .basename(normalizedTarget)
          .replace(/\.md$/i, "")

        const backlinks: string[] = []

        for (const base of vaultDirectories) {
          const stack: string[] = [base]
          while (stack.length > 0) {
            const current = stack.pop() as string
            const entries = await fs.readdir(current, { withFileTypes: true })
            for (const entry of entries) {
              const fullPath = path.join(current, entry.name)
              try {
                await validatePath(fullPath)
              } catch {
                continue
              }
              if (entry.isDirectory()) {
                stack.push(fullPath)
              } else if (entry.isFile() && entry.name.endsWith(".md")) {
                const rel = fullPath.replace(base, "")
                const validPath = await validatePath(fullPath)
                const raw = await fs.readFile(validPath, "utf-8")
                const links = extractLinks(raw)
                const hasBacklink = links.some((link) => {
                  // Decode URL-encoded paths (e.g., %20 -> space) for proper matching
                  let decoded: string
                  try {
                    decoded = decodeURIComponent(link)
                  } catch {
                    decoded = link // fallback if invalid encoding
                  }
                  const norm = decoded.replace(/\\/g, "/")
                  const baseName = path.basename(norm).replace(/\.md$/i, "")
                  return (
                    norm === normalizedTarget ||
                    baseName === targetBase ||
                    norm.endsWith("/" + normalizedTarget)
                  )
                })
                if (hasBacklink) {
                  backlinks.push(rel)
                }
              }
            }
          }
        }

        return {
          content: [
            {
              type: "text",
              text:
                backlinks.length > 0
                  ? backlinks.join("\n")
                  : `No backlinks found for target "${target}".`,
            },
          ],
        }
      }
      case "obsidian_search_content": {
        const parsed = ObsidianSearchContentArgsSchema.safeParse(args)
        if (!parsed.success) {
          throw new Error(
            `Invalid arguments for obsidian_search_content: ${parsed.error}`
          )
        }

        const { query, maxResults, includeContext } = parsed.data
        const limit = Math.min(maxResults ?? CONTENT_SEARCH_LIMIT, 1000)
        const regex = buildSearchRegex(query)

        const lines: string[] = []
        let count = 0

        for (const base of vaultDirectories) {
          const stack: string[] = [base]
          while (stack.length > 0 && count < limit) {
            const current = stack.pop() as string
            const entries = await fs.readdir(current, { withFileTypes: true })
            for (const entry of entries) {
              if (count >= limit) break
              const fullPath = path.join(current, entry.name)
              try {
                await validatePath(fullPath)
              } catch {
                continue
              }
              if (entry.isDirectory()) {
                stack.push(fullPath)
              } else if (entry.isFile() && entry.name.endsWith(".md")) {
                const rel = fullPath.replace(base, "")
                const validPath = await validatePath(fullPath)
                const raw = await fs.readFile(validPath, "utf-8")
                const content = raw
                let idx: number | null = null
                if (regex) {
                  const m = regex.exec(content)
                  idx = m ? m.index : -1
                } else {
                  idx = content.toLowerCase().indexOf(query.toLowerCase())
                }
                if (idx != null && idx >= 0) {
                  count++
                  if (includeContext) {
                    const snippet = buildContentSnippet(content, idx)
                    lines.push(`${rel}:\n${snippet}\n`)
                  } else {
                    lines.push(rel)
                  }
                }
              }
            }
          }
        }

        const header =
          count > limit
            ? `Showing first ${limit} matches out of at least ${count}.`
            : `Found ${count} matching notes.`

        return {
          content: [
            {
              type: "text",
              text:
                (lines.length > 0 ? lines.join("\n---\n") : "No matches found.") +
                `\n\n${header}`,
            },
          ],
        }
      }
      case "obsidian_query": {
        const parsed = ObsidianQueryArgsSchema.safeParse(args)
        if (!parsed.success) {
          throw new Error(
            `Invalid arguments for obsidian_query: ${parsed.error}`
          )
        }

        const { cleanedQuery, range } = parseNaturalLanguageDateRange(
          parsed.data.query
        )
        const limit = Math.min(parsed.data.maxResults ?? 50, 500)

        const tokens = cleanedQuery
          .split(/[^A-Za-z0-9]+/)
          .map((t: string) => t.toLowerCase())
          .filter(
            (t: string) =>
              t.length > 2 &&
              !["was", "were", "the", "and", "for", "with", "have", "has"].includes(
                t
              )
          )

        const results: {
          path: string
          snippet: string
          created?: string
          tags?: string[]
          score?: number
        }[] = []

        for (const base of vaultDirectories) {
          const stack: string[] = [base]
          while (stack.length > 0 && results.length < limit) {
            const current = stack.pop() as string
            const entries = await fs.readdir(current, { withFileTypes: true })
            for (const entry of entries) {
              if (results.length >= limit) break
              const fullPath = path.join(current, entry.name)
              try {
                await validatePath(fullPath)
              } catch {
                continue
              }
              if (entry.isDirectory()) {
                stack.push(fullPath)
              } else if (entry.isFile() && entry.name.endsWith(".md")) {
                const rel = fullPath.replace(base, "")
                const note = await readNote(rel)
                const noteDate = parseNoteDate(note)
                if (!dateInRange(noteDate, range)) {
                  continue
                }

                const tags = extractAllTags(note)
                const haystack =
                  note.content.toLowerCase() +
                  "\n" +
                  tags.join(" ").toLowerCase()

                // Calculate how many tokens match (scored matching)
                const matchCount = tokens.filter((t) => haystack.includes(t)).length
                const matchRatio = tokens.length > 0 ? matchCount / tokens.length : 1

                // Require at least half the tokens to match (or all if only 1-2 tokens)
                const minMatchRatio = tokens.length <= 2 ? 1 : 0.5
                const hasEnoughMatches = matchRatio >= minMatchRatio

                if (hasEnoughMatches) {
                  let idx = -1
                  if (tokens.length > 0) {
                    for (const t of tokens) {
                      const found = haystack.indexOf(t)
                      if (found >= 0) {
                        idx = found
                        break
                      }
                    }
                  } else {
                    idx = 0
                  }
                  const snippet = buildContentSnippet(note.content, Math.max(0, idx))
                  results.push({
                    path: rel,
                    snippet,
                    created: note.frontmatter?.created as string | undefined,
                    tags,
                    score: matchRatio,
                  })
                }
              }
            }
          }
        }

        if (results.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: "No notes found matching the query.",
              },
            ],
          }
        }

        // Sort results by score (highest first) for better relevance
        results.sort((a, b) => (b.score ?? 0) - (a.score ?? 0))

        const lines: string[] = []
        if (range) {
          lines.push(
            `Date range: ${range.start.toISOString()} → ${range.end.toISOString()}`
          )
        }
        lines.push(`Matches: ${results.length}`)
        for (const r of results) {
          lines.push(
            `\n${r.path}` +
              (r.created ? ` (created: ${r.created})` : "") +
              (r.tags && r.tags.length > 0
                ? `\nTags: ${r.tags.join(", ")}`
                : "") +
              `\n${r.snippet}`
          )
        }

        return {
          content: [
            {
              type: "text",
              text: lines.join("\n"),
            },
          ],
        }
      }
      case "obsidian_count_files": {
        const parsed = ObsidianCountFilesArgsSchema.safeParse(args)
        if (!parsed.success) {
          throw new Error(
            `Invalid arguments for obsidian_count_files: ${parsed.error}`
          )
        }

        let targetFolder = parsed.data.folder || ""
        const includeSubfolders = parsed.data.includeSubfolders !== false
        const includeNames = parsed.data.includeNames === true

        let totalCount = 0
        const folderCounts: Record<string, number> = {}
        const fileNames: string[] = []
        const MAX_FILE_NAMES = 100

        // Resolve the actual folder path
        let resolvedFolder = targetFolder
        let folderFoundDirectly = false

        for (const base of vaultDirectories) {
          const directPath = targetFolder 
            ? path.join(base, targetFolder) 
            : base

          try {
            const stats = await fs.stat(directPath)
            if (stats.isDirectory()) {
              folderFoundDirectly = true
              break
            }
          } catch {
            // Direct path not found, will try fuzzy search
          }
        }

        // If folder not found directly and a folder name was provided, search by name
        if (!folderFoundDirectly && targetFolder) {
          const matchingFolders = await findFoldersByName(targetFolder)
          
          if (matchingFolders.length === 0) {
            return {
              content: [
                {
                  type: "text",
                  text: `Error: Folder "${targetFolder}" not found in vault.`,
                },
              ],
              isError: true,
            }
          } else if (matchingFolders.length === 1) {
            // Single match found - use it
            resolvedFolder = matchingFolders[0]
          } else {
            // Multiple matches - ask user to clarify
            return {
              content: [
                {
                  type: "text",
                  text: `Multiple folders named "${targetFolder}" found:\n\n${matchingFolders.map(f => `  ${f}`).join('\n')}\n\nPlease specify the full path.`,
                },
              ],
            }
          }
        }

        for (const base of vaultDirectories) {
          const startPath = resolvedFolder 
            ? path.join(base, resolvedFolder) 
            : base

          // Verify the path exists and is accessible
          try {
            const stats = await fs.stat(startPath)
            if (!stats.isDirectory()) {
              continue
            }
          } catch {
            continue
          }

          const stack: { path: string; depth: number }[] = [{ path: startPath, depth: 0 }]
          
          while (stack.length > 0) {
            const { path: current, depth } = stack.pop()!
            const entries = await fs.readdir(current, { withFileTypes: true })
            
            for (const entry of entries) {
              const fullPath = path.join(current, entry.name)
              
              try {
                await validatePath(fullPath)
              } catch {
                continue
              }

              if (entry.isDirectory()) {
                if (includeSubfolders || depth === 0) {
                  stack.push({ path: fullPath, depth: depth + 1 })
                }
              } else if (entry.isFile() && entry.name.endsWith(".md")) {
                totalCount++
                
                // Collect file names if requested (up to limit)
                if (includeNames && fileNames.length < MAX_FILE_NAMES) {
                  const relativePath = fullPath.replace(startPath, "").replace(/^[/\\]/, "")
                  fileNames.push(relativePath)
                }
                
                // Track counts by immediate subfolder (depth 1)
                if (depth === 0) {
                  folderCounts["(root)"] = (folderCounts["(root)"] || 0) + 1
                } else {
                  // Find immediate subfolder name
                  const relativePath = fullPath.replace(startPath, "")
                  const parts = relativePath.split(path.sep).filter(p => p.length > 0)
                  if (parts.length >= 1) {
                    const immediateFolder = parts[0]
                    folderCounts[immediateFolder] = (folderCounts[immediateFolder] || 0) + 1
                  }
                }
              }
            }
          }
        }

        // Build response
        const lines: string[] = []
        const folderLabel = resolvedFolder || "vault"
        
        // Show if folder was resolved from a different input
        if (resolvedFolder !== targetFolder && targetFolder) {
          lines.push(`Found folder: ${resolvedFolder}`)
        }
        lines.push(`Total files in ${folderLabel}: ${totalCount}`)
        
        if (Object.keys(folderCounts).length > 1 || (Object.keys(folderCounts).length === 1 && !folderCounts["(root)"])) {
          lines.push("")
          lines.push("Breakdown by folder:")
          const sorted = Object.entries(folderCounts)
            .sort((a, b) => b[1] - a[1])
          for (const [folder, count] of sorted) {
            lines.push(`  ${folder}: ${count}`)
          }
        }

        // Include file names if requested
        if (includeNames && fileNames.length > 0) {
          lines.push("")
          lines.push("Files:")
          // Sort alphabetically
          fileNames.sort((a, b) => a.localeCompare(b))
          for (const fileName of fileNames) {
            lines.push(`  ${fileName}`)
          }
          if (totalCount > MAX_FILE_NAMES) {
            lines.push(`  ... and ${totalCount - MAX_FILE_NAMES} more files`)
          }
        }

        return {
          content: [
            {
              type: "text",
              text: lines.join("\n"),
            },
          ],
        }
      }
      default:
        throw new Error(`Unknown tool: ${name}`)
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    return {
      content: [{ type: "text", text: `Error: ${errorMessage}` }],
      isError: true,
    }
  }
})

// Start server
async function runServer() {
  const transport = new StdioServerTransport()
  await server.connect(transport)
  console.error("MCP Obsidian Server running on stdio")
  console.error("Allowed directories:", vaultDirectories)
}

runServer().catch((error) => {
  console.error("Fatal error running server:", error)
  process.exit(1)
})

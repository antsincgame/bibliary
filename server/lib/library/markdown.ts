import type { BookMetadata, BookSection } from "../scanner/parser-types.js";

/**
 * Minimal markdown builder used when a book is first imported, BEFORE
 * the LLM layout cleanup and AI metadata-enrichment passes run (those
 * live in Phase 6). Frontmatter is YAML-lite — just enough so a later
 * pass can read+rewrite via parseFrontmatter/replaceFrontmatter from
 * electron/lib/library/md-converter.ts without re-parsing the source.
 */
export interface BuildMarkdownInput {
  metadata: BookMetadata;
  sections: BookSection[];
  originalFile: string;
  sha256: string;
}

export function buildBookMarkdown(input: BuildMarkdownInput): string {
  const frontmatter = buildFrontmatter(input);
  const body = sectionsToMarkdown(input.sections);
  return `${frontmatter}\n${body}`;
}

function escapeYaml(value: string): string {
  if (value === "") return '""';
  if (/[:#&*!|>'"%@`{}\[\],]|^\s|\s$/.test(value)) {
    return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  }
  return value;
}

function buildFrontmatter(input: BuildMarkdownInput): string {
  const meta = input.metadata;
  const lines: string[] = ["---"];
  lines.push(`title: ${escapeYaml(meta.title || input.originalFile)}`);
  if (meta.author) lines.push(`author: ${escapeYaml(meta.author)}`);
  if (meta.language) lines.push(`language: ${escapeYaml(meta.language)}`);
  if (meta.year) lines.push(`year: ${meta.year}`);
  if (meta.publisher) lines.push(`publisher: ${escapeYaml(meta.publisher)}`);
  if (meta.identifier) lines.push(`identifier: ${escapeYaml(meta.identifier)}`);
  lines.push(`sha256: ${input.sha256}`);
  lines.push(`originalFile: ${escapeYaml(input.originalFile)}`);
  lines.push("---");
  return lines.join("\n");
}

function sectionsToMarkdown(sections: BookSection[]): string {
  if (sections.length === 0) return "_No content extracted._\n";
  const parts: string[] = [];
  for (const s of sections) {
    const hashes = "#".repeat(Math.max(1, Math.min(6, s.level + 1)));
    parts.push(`${hashes} ${s.title.trim()}`);
    parts.push("");
    for (const p of s.paragraphs) {
      const trimmed = p.trim();
      if (trimmed) {
        parts.push(trimmed);
        parts.push("");
      }
    }
  }
  return parts.join("\n");
}

/**
 * Naive word-count for status badge. Counts whitespace-delimited tokens
 * over the paragraph text only (frontmatter excluded). Used as a
 * lightweight stand-in for the LLM-driven `wordCount` field on books
 * collection — refined in Phase 6 when proper tokenization runs.
 */
export function estimateWordCount(sections: BookSection[]): number {
  let total = 0;
  for (const s of sections) {
    for (const p of s.paragraphs) {
      const tokens = p.trim().split(/\s+/u).filter(Boolean);
      total += tokens.length;
    }
  }
  return total;
}

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseMarkdownToSections } from "../electron/lib/scanner/parsers/pdf-inspector-parser.js";

describe("edgeparse pipeline → parseMarkdownToSections (shared parser)", () => {
  it("handles XY-Cut++ markdown with complex tables", () => {
    const md = [
      "# A Tour of C++ Second Edition",
      "",
      "Visit informit.com for a complete list.",
      "",
      "## Chapter 1: The Basics",
      "",
      "The basics of C++ programming.",
      "",
      "| Feature | Supported |",
      "|---------|-----------|",
      "| Classes | Yes |",
      "| Templates | Yes |",
      "",
      "### 1.1 Introduction",
      "",
      "This section introduces the basics.",
    ].join("\n");

    const sections = parseMarkdownToSections(md);
    assert.ok(sections.length >= 3, `expected >=3, got ${sections.length}`);

    const ch1 = sections.find((s) => s.title.includes("The Basics"));
    assert.ok(ch1, "Chapter 1 section missing");
    const tableContent = ch1!.paragraphs.find((p) => p.includes("Feature"));
    assert.ok(tableContent, "Table should be preserved as paragraph");
    assert.ok(tableContent!.includes("|"), "Pipe table syntax preserved");
  });

  it("XY-Cut reading order preserves multi-column content", () => {
    const md = [
      "# Multi-Column Document",
      "",
      "First column paragraph with important content.",
      "",
      "Second column paragraph with more details.",
      "",
      "Third paragraph spanning full width.",
    ].join("\n");

    const sections = parseMarkdownToSections(md);
    assert.equal(sections.length, 1);
    assert.equal(sections[0]!.paragraphs.length, 3);
  });

  it("handles password-protected PDF edge case (empty output)", () => {
    const sections = parseMarkdownToSections("");
    assert.equal(sections.length, 0);
  });

  it("preserves code fences from technical books", () => {
    const md = [
      "# Programming Guide",
      "",
      "Here is an example:",
      "",
      "```cpp",
      "#include <iostream>",
      "int main() {",
      "  std::cout << \"Hello\";",
      "}",
      "```",
      "",
      "The above shows a basic program.",
    ].join("\n");

    const sections = parseMarkdownToSections(md);
    assert.equal(sections.length, 1);
    const code = sections[0]!.paragraphs.find((p) => p.includes("iostream"));
    assert.ok(code, "Code fence should be preserved as paragraph");
  });
});

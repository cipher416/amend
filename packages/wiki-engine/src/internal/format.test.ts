import { describe, expect, it } from "vitest"

import { parseMarkdownFrontmatter } from "./format.ts"

describe("wiki markdown format", () => {
  it("parses frontmatter from Windows CRLF files", () => {
    const parsed = parseMarkdownFrontmatter(
      "---\r\ntitle: Attention\r\ntags: [transformer]\r\n---\r\n\r\n# Attention\r\n",
      "concepts/attention.md"
    )

    expect(parsed.frontmatter.get("title")).toBe("Attention")
    expect(parsed.frontmatter.get("tags")).toEqual(["transformer"])
    expect(parsed.body).toBe("# Attention\r\n")
  })
})

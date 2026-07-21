import { Link, useNavigate } from "@tanstack/react-router"
import type { WikiFileContent, WikiFileTreeItem } from "@workspace/contract"
import type { JSX } from "react"
import type { Components } from "streamdown"
import { defaultRehypePlugins, Streamdown } from "streamdown"

export interface MarkdownDocument {
  body: string
  metadata: {
    title?: string
    created?: string
    updated?: string
    type?: string
    tags: readonly string[]
    sources: readonly string[]
  }
}

export function parseMarkdownDocument(content: string): MarkdownDocument {
  const normalizedContent = content.replaceAll("\r\n", "\n")
  const metadata: {
    title?: string
    created?: string
    updated?: string
    type?: string
    tags: string[]
    sources: string[]
  } = { tags: [], sources: [] }
  if (!normalizedContent.startsWith("---\n")) {
    return { body: normalizedContent, metadata }
  }
  const end = normalizedContent.indexOf("\n---\n", 4)
  if (end === -1) return { body: normalizedContent, metadata }

  let listKey: "tags" | "sources" | undefined
  for (const line of normalizedContent.slice(4, end).split("\n")) {
    const listItem = /^\s+-\s+(.+)$/.exec(line)
    if (listItem && listKey) {
      metadata[listKey].push(unquoteFrontmatterValue(listItem[1]))
      continue
    }

    const field = /^(title|created|updated|type|tags|sources):\s*(.*)$/.exec(
      line
    )
    if (!field) {
      listKey = undefined
      continue
    }

    const key = field[1] as keyof MarkdownDocument["metadata"]
    const value = field[2].trim()
    if (key === "tags" || key === "sources") {
      listKey = key
      if (value) metadata[key].push(...parseFrontmatterList(value))
    } else if (value) {
      metadata[key] = unquoteFrontmatterValue(value)
      listKey = undefined
    }
  }

  return {
    body: normalizedContent.slice(end + "\n---\n".length).replace(/^\n/, ""),
    metadata,
  }
}

export function WikiFileViewer({
  file,
  document,
  wikiId,
  files,
}: {
  file: WikiFileContent
  document?: MarkdownDocument
  wikiId: string
  files: readonly WikiFileTreeItem[]
}) {
  if (file.mediaType === "binary") {
    return (
      <div className="rounded-lg border bg-card p-6 text-card-foreground">
        <p className="text-sm font-medium">Preview unavailable</p>
        <p className="mt-1 text-sm text-muted-foreground">
          {file.name} is a binary file ({file.size} bytes).
        </p>
      </div>
    )
  }
  if (file.mediaType === "markdown") {
    return (
      <article className="text-card-foreground">
        {document ? (
          <DocumentMetadata document={document} wikiId={wikiId} />
        ) : null}
        <Streamdown
          mode="static"
          className="space-y-5 text-[0.9375rem] leading-7 text-foreground [&_a]:text-primary [&_a]:underline [&_a]:underline-offset-4 [&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-4 [&_blockquote]:text-muted-foreground [&_code]:rounded [&_code]:bg-muted [&_code]:px-1.5 [&_code]:py-0.5 [&_h1]:mt-0 [&_h1]:text-3xl [&_h1]:font-medium [&_h1]:tracking-tight [&_h2]:mt-7 [&_h2]:text-2xl [&_h2]:font-medium [&_h2]:tracking-tight [&_h3]:mt-6 [&_h3]:text-xl [&_h3]:font-medium [&_li]:my-1 [&_ol]:list-decimal [&_ol]:pl-6 [&_pre]:scroll-fade-x [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:border [&_pre]:bg-muted [&_pre]:p-4 [&_table]:w-full [&_table]:border-collapse [&_td]:border [&_td]:p-2 [&_th]:border [&_th]:bg-muted [&_th]:p-2 [&_ul]:list-disc [&_ul]:pl-6"
          components={{ a: WikiMarkdownLink }}
          rehypePlugins={[defaultRehypePlugins.sanitize]}
          urlTransform={(url) =>
            wikiFileRoute(url) || isSafeExternalUrl(url) ? url : null
          }
        >
          {resolveWikiLinks(
            document?.body ?? file.content ?? "",
            wikiId,
            files
          )}
        </Streamdown>
      </article>
    )
  }
  return (
    <article className="rounded-xl border bg-card text-card-foreground shadow-xs">
      <div className="border-b px-5 py-3 font-mono text-[0.6875rem] text-muted-foreground">
        {file.path} · {file.size} bytes
      </div>
      <div className="scroll-fade-x overflow-x-auto px-6 py-5 text-[0.9375rem] leading-7 whitespace-pre-wrap text-foreground">
        {file.content}
      </div>
    </article>
  )
}

function parseFrontmatterList(value: string): readonly string[] {
  const items =
    value.startsWith("[") && value.endsWith("]")
      ? value.slice(1, -1).split(",")
      : [value]
  return items
    .map((item) => unquoteFrontmatterValue(item.trim()))
    .filter(Boolean)
}

function unquoteFrontmatterValue(value: string): string {
  return value.replace(/^(?:"([\s\S]*)"|'([\s\S]*)')$/, "$1$2")
}

function DocumentMetadata({
  document,
  wikiId,
}: {
  document: MarkdownDocument
  wikiId: string
}) {
  const { created, updated, type, tags, sources } = document.metadata
  if (!created && !updated && !type && !tags.length && !sources.length)
    return null

  return (
    <dl className="mb-8 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted-foreground">
      {type ? (
        <div>
          <dt className="sr-only">Type</dt>
          <dd className="font-medium tracking-[0.12em] uppercase">{type}</dd>
        </div>
      ) : null}
      {created ? (
        <div>
          <dt className="sr-only">Created</dt>
          <dd>Created {created}</dd>
        </div>
      ) : null}
      {updated ? (
        <div>
          <dt className="sr-only">Updated</dt>
          <dd>Updated {updated}</dd>
        </div>
      ) : null}
      {tags.length ? (
        <div>
          <dt className="sr-only">Tags</dt>
          <dd className="flex flex-wrap gap-1.5">
            {tags.map((tag) => (
              <span
                key={tag}
                className="rounded-full bg-muted px-2 py-0.5 text-muted-foreground"
              >
                {tag}
              </span>
            ))}
          </dd>
        </div>
      ) : null}
      {sources.length ? (
        <div className="basis-full pt-1">
          <dt className="mr-2 inline">Sources</dt>
          <dd className="inline">
            {sources.map((source, index) => (
              <span key={source}>
                {index ? <span className="mr-1">,</span> : null}
                <Link
                  className="text-foreground underline decoration-muted-foreground/40 underline-offset-4 transition-colors hover:decoration-foreground"
                  to="/wiki/$wikiId/$"
                  params={{ wikiId, _splat: source }}
                >
                  {source}
                </Link>
              </span>
            ))}
          </dd>
        </div>
      ) : null}
    </dl>
  )
}

function resolveWikiLinks(
  content: string,
  wikiId: string,
  files: readonly WikiFileTreeItem[]
): string {
  const markdownFiles = collectMarkdownFiles(files)
  return content.replace(
    /\[\[([^\]|#]+)(?:#([^\]|]+))?(?:\|([^\]]+))?\]\]/g,
    (match, rawTarget: string, rawFragment?: string, rawLabel?: string) => {
      const target = rawTarget.trim().replace(/\.md(?:own)?$/i, "")
      const matches = markdownFiles.filter((path) => {
        const page = path.replace(/\.md(?:own)?$/i, "")
        return page === target || page.endsWith(`/${target}`)
      })
      if (matches.length !== 1) return match
      const fragment = rawFragment
        ? `#${encodeURIComponent(rawFragment.trim())}`
        : ""
      const label = escapeMarkdownLinkLabel((rawLabel ?? rawTarget).trim())
      return `[${label}](${wikiFileHref(wikiId, matches[0])}${fragment})`
    }
  )
}

function escapeMarkdownLinkLabel(value: string): string {
  return value.replace(/[\\[\]]/g, "\\$&")
}

function collectMarkdownFiles(
  items: readonly WikiFileTreeItem[]
): readonly string[] {
  const files: string[] = []
  for (const item of items) {
    if (item.kind === "directory") {
      files.push(...collectMarkdownFiles(item.children ?? []))
    } else if (/\.md(?:own)?$/i.test(item.path)) {
      files.push(item.path)
    }
  }
  return files
}

function wikiFileHref(wikiId: string, path: string): string {
  const encodedPath = path.split("/").map(encodeURIComponent).join("/")
  return `/wiki/${encodeURIComponent(wikiId)}/${encodedPath}`
}

type WikiMarkdownLinkComponent = Exclude<
  Components["a"],
  keyof JSX.IntrinsicElements | undefined
>

const WikiMarkdownLink: WikiMarkdownLinkComponent = ({
  href,
  onClick,
  node: _node,
  ref: _ref,
  ...props
}) => {
  const navigate = useNavigate()
  const target = href ? wikiFileRoute(href) : undefined
  if (!target) {
    return (
      <a
        href={href}
        target="_blank"
        rel="noreferrer"
        onClick={onClick}
        {...props}
      />
    )
  }
  return (
    <a
      href={href}
      onClick={(event) => {
        onClick?.(event)
        if (
          event.defaultPrevented ||
          event.button !== 0 ||
          event.metaKey ||
          event.altKey ||
          event.ctrlKey ||
          event.shiftKey
        ) {
          return
        }
        event.preventDefault()
        void navigate({
          to: "/wiki/$wikiId/$",
          params: {
            wikiId: target.wikiId,
            _splat: target.path,
          },
          hash: target.hash,
        })
      }}
      {...props}
    />
  )
}

function wikiFileRoute(
  href: string
): { wikiId: string; path: string; hash: string } | undefined {
  if (!href.startsWith("/") || href.startsWith("//")) return undefined
  try {
    const url = new URL(href, "https://amend.invalid")
    const segments = url.pathname.split("/").filter(Boolean)
    if (segments[0] !== "wiki" || segments.length < 3) return undefined
    return {
      wikiId: decodeURIComponent(segments[1]),
      path: segments.slice(2).map(decodeURIComponent).join("/"),
      hash: url.hash.slice(1),
    }
  } catch {
    return undefined
  }
}

function isSafeExternalUrl(url: string): boolean {
  try {
    return ["http:", "https:", "mailto:"].includes(new URL(url).protocol)
  } catch {
    return false
  }
}

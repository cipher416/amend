# Amend

Amend is a local-first, self-maintaining wiki. This workspace starts from the
shadcn/ui TanStack Start monorepo template.

## Development

```bash
mise install
pnpm install
pnpm dev
```

`pnpm dev` starts the Vite development server and Electron together. The
development server is used only for hot module replacement.

Build the serverless desktop package with:

```bash
pnpm package:desktop
```

Add shadcn/ui components from the workspace root:

```bash
pnpm dlx shadcn@latest add button -c apps/web
```

Components are installed in `packages/ui/src/components` and imported from the
shared `@workspace/ui` package.

## Desktop Boundary

TanStack Start emits a prerendered SPA shell for Electron. Packaged builds copy
only the static client output and load it through the secure `app://amend/`
protocol; the Start server bundle is not packaged or started. Electron-only
capabilities must remain behind typed preload IPC. Do not use runtime Start
server functions for Git, filesystem, database, credentials, or model access.

## Connecting a Model Provider

Before the first wiki can be created, Amend needs a Pi model provider
connected. If `~/.pi/agent/settings.json` does not already name a provider with
stored credentials, onboarding shows a connect step instead of the wiki
form. From there, users can:

- Sign in with Anthropic (Claude Pro/Max) or ChatGPT Plus/Pro (Codex) through a
  browser-based OAuth flow. Amend opens the system browser and, if the
  automatic redirect does not complete, prompts for a manually pasted code.
- Enter a plain API key for any other provider the Pi model registry knows
  about (OpenAI, Z.ai, Google, Mistral, and more).

Either path ends with picking a default model for that provider, which Amend
writes to `~/.pi/agent/settings.json` alongside the credential in
`~/.pi/agent/auth.json`. Credential storage, OAuth token exchange, and browser
launching all happen in the Electron main process; the renderer only ever sees
provider ids, model ids, and login-progress events.

## First Ingest

Creating a wiki requires Git on the desktop application's `PATH`. The first
source can be a PDF, Markdown file, or UTF-8 text file up to 25 MB; selection
and text extraction stay in the Electron main process. Ingest uses the default
provider and model in `~/.pi/agent/settings.json`, with credentials resolved by
Pi from its auth storage. Amend bundles its pinned wiki-maintenance skill;
source material, credentials, Git, and the SQLite search index remain in the
Electron main process. Ingest runs as a main-process job, so renderer reloads
reconnect to its latest status. Jobs live only for the current application
session, and can be cancelled until Git commit promotion begins.

## Wiki Lifecycle

On first use, Amend asks for one wiki home. Every wiki is a sibling Git
repository directly under that directory; the home also contains a hidden
`.amend` directory for Amend metadata. Each wiki has a stable ID stored in its
own `.amend/wiki.json` metadata file.

The selected home and last active wiki ID live in Electron `userData`. Amend
discovers wikis by scanning the wiki home, then restores the last active wiki
when it is still present. External repositories cannot be opened as wikis.

The SQLite search index is a derived cache keyed by stable wiki ID. The app can
switch between discovered sibling wikis without cancelling an ingest in another
wiki. Ingest updates are tagged with their originating wiki ID so the renderer
only applies them to the matching active wiki.

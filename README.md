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
stored credentials, onboarding shows a connect step instead of the workspace
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

## Workspace Lifecycle

Each Amend workspace is a local Git repository with a stable ID stored in
`.amend/workspace.json`. The desktop app also keeps a machine-local catalog in
Electron `userData`, recording known workspace paths and the last active
workspace. On launch, Amend restores the last active workspace when it is still
valid; otherwise it starts without blocking the app.

Existing workspaces can be opened from the app. Older workspaces with a version 1
manifest are migrated once by committing updated workspace metadata. The SQLite
search index is a derived cache keyed by the stable workspace ID, so moving a
workspace keeps its identity and causes the local index cache to be rebuilt when
needed.

The app can switch between known workspaces in-app. Switching changes the active
workspace for viewing and source selection, but it does not cancel a currently
running ingest in another workspace. Ingest updates are tagged with the
originating workspace ID so the renderer only applies them to the matching active
workspace.

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

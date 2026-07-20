import { spawnSync } from "node:child_process"

import electronPath from "electron"

const program = `
  const { DatabaseSync } = require("node:sqlite")
  const database = new DatabaseSync(":memory:")
  database.exec("CREATE VIRTUAL TABLE documents USING fts5(body)")
  database.prepare("INSERT INTO documents(body) VALUES (?)").run("electron full text search")
  const result = database.prepare("SELECT body FROM documents WHERE documents MATCH 'search'").get()
  database.close()
  process.stdout.write(JSON.stringify({
    electron: process.versions.electron,
    node: process.version,
    sqlite: process.versions.sqlite,
    fts5: result?.body === "electron full text search",
  }))
`

const result = spawnSync(electronPath, ["-e", program], {
  encoding: "utf8",
  env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
  timeout: 15_000,
})

if (result.error) {
  throw new Error("Electron SQLite smoke test could not run", {
    cause: result.error,
  })
}
if (result.status !== 0) {
  throw new Error(
    result.stderr ||
      `Electron SQLite smoke test failed${result.signal ? ` with signal ${result.signal}` : ""}`
  )
}

const versions = JSON.parse(result.stdout)
if (versions.fts5 !== true) {
  throw new Error("Electron SQLite does not support FTS5")
}

process.stdout.write(`${JSON.stringify(versions)}\n`)

import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"

import {
  assertReleaseVersions,
  collectReleaseArtifacts,
  releaseVersionFromTag,
  writeReleaseChecksums,
} from "./release-lib.mjs"

test("releaseVersionFromTag accepts stable and prerelease semantic versions", () => {
  assert.equal(releaseVersionFromTag("v0.1.0"), "0.1.0")
  assert.equal(
    releaseVersionFromTag("v2.3.4-alpha.1+build.7"),
    "2.3.4-alpha.1+build.7"
  )
})

test("releaseVersionFromTag rejects ambiguous or invalid release tags", () => {
  for (const tag of ["0.1.0", "latest", "v01.2.3", "v1.2", "v1.0.0-alpha.01"]) {
    assert.throws(() => releaseVersionFromTag(tag), /semantic version/)
  }
})

test("assertReleaseVersions requires every package to match the tag", () => {
  assert.equal(
    assertReleaseVersions("v0.1.0-alpha.1", {
      root: "0.1.0-alpha.1",
      desktop: "0.1.0-alpha.1",
    }),
    "0.1.0-alpha.1"
  )

  assert.throws(
    () =>
      assertReleaseVersions("v0.1.0", {
        root: "0.1.0",
        desktop: "0.0.1",
      }),
    /desktop version 0\.0\.1 does not match/
  )
})

test("collectReleaseArtifacts flattens distributables and ignores other output", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "amend-release-"))
  const input = path.join(workspace, "make")
  const output = path.join(workspace, "release")
  await mkdir(path.join(input, "zip", "linux", "x64"), { recursive: true })
  await mkdir(path.join(input, "logs"), { recursive: true })
  await writeFile(
    path.join(input, "zip", "linux", "x64", "Amend-linux-x64.zip"),
    "archive"
  )
  await writeFile(path.join(input, "logs", "make.log"), "ignored")

  assert.deepEqual(await collectReleaseArtifacts(input, output), [
    "Amend-linux-x64.zip",
  ])
  assert.equal(
    await readFile(path.join(output, "Amend-linux-x64.zip"), "utf8"),
    "archive"
  )
})

test("collectReleaseArtifacts rejects duplicate distributable filenames", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "amend-release-"))
  const input = path.join(workspace, "make")
  const output = path.join(workspace, "release")
  await mkdir(path.join(input, "one"), { recursive: true })
  await mkdir(path.join(input, "two"), { recursive: true })
  await writeFile(path.join(input, "one", "Amend.zip"), "one")
  await writeFile(path.join(input, "two", "Amend.zip"), "two")

  await assert.rejects(
    collectReleaseArtifacts(input, output),
    /share the filename Amend\.zip/
  )
})

test("writeReleaseChecksums writes sorted SHA-256 entries", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "amend-release-"))
  await writeFile(path.join(workspace, "b.zip"), "bravo")
  await writeFile(path.join(workspace, "a.zip"), "alpha")
  const output = path.join(workspace, "SHA256SUMS.txt")

  const checksums = await writeReleaseChecksums(workspace, output)
  const alpha = createHash("sha256").update("alpha").digest("hex")
  const bravo = createHash("sha256").update("bravo").digest("hex")

  assert.deepEqual(checksums, [`${alpha}  a.zip`, `${bravo}  b.zip`])
  assert.equal(
    await readFile(output, "utf8"),
    `${alpha}  a.zip\n${bravo}  b.zip\n`
  )
})

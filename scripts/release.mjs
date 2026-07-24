#!/usr/bin/env node

import path from "node:path"
import process from "node:process"

import {
  assertReleaseVersions,
  collectReleaseArtifacts,
  packageVersion,
  writeReleaseChecksums,
} from "./release-lib.mjs"

const [, , command, ...args] = process.argv

try {
  if (command === "verify") {
    const [tag] = args
    if (!tag) throw new Error("Usage: release.mjs verify <tag>")

    const rootPackage = path.resolve("package.json")
    const desktopPackage = path.resolve("apps/desktop/package.json")
    const version = assertReleaseVersions(tag, {
      "root package": await packageVersion(rootPackage),
      "desktop package": await packageVersion(desktopPackage),
    })

    console.log(`Release tag ${tag} matches package version ${version}.`)
  } else if (command === "collect") {
    const [inputDirectory, outputDirectory] = args
    if (!inputDirectory || !outputDirectory) {
      throw new Error(
        "Usage: release.mjs collect <forge-output-directory> <release-output-directory>"
      )
    }

    const artifacts = await collectReleaseArtifacts(
      path.resolve(inputDirectory),
      path.resolve(outputDirectory)
    )
    console.log(`Collected ${artifacts.length} release artifact(s):`)
    for (const artifact of artifacts) console.log(`- ${artifact}`)
  } else if (command === "checksums") {
    const [directory, outputPath] = args
    if (!directory || !outputPath) {
      throw new Error(
        "Usage: release.mjs checksums <release-directory> <checksum-file>"
      )
    }

    const checksums = await writeReleaseChecksums(
      path.resolve(directory),
      path.resolve(outputPath)
    )
    console.log(`Wrote ${checksums.length} SHA-256 checksum(s).`)
  } else {
    throw new Error(
      "Usage: release.mjs <verify|collect|checksums> [...arguments]"
    )
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
}

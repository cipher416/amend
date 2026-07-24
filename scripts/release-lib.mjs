import { createHash } from "node:crypto"
import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  stat,
  writeFile,
} from "node:fs/promises"
import path from "node:path"

const RELEASE_TAG_PATTERN =
  /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/

const DISTRIBUTABLE_EXTENSIONS = new Set([
  ".appimage",
  ".blockmap",
  ".deb",
  ".dmg",
  ".exe",
  ".msi",
  ".nupkg",
  ".rpm",
  ".zip",
])

export function releaseVersionFromTag(tag) {
  const match = RELEASE_TAG_PATTERN.exec(tag)
  if (!match) {
    throw new Error(
      `Release tag "${tag}" must be a semantic version prefixed with "v", for example v0.1.0 or v0.1.0-alpha.1.`
    )
  }

  const prerelease = match[4]
  if (
    prerelease &&
    prerelease
      .split(".")
      .some(
        (identifier) =>
          /^\d+$/.test(identifier) &&
          identifier.length > 1 &&
          identifier.startsWith("0")
      )
  ) {
    throw new Error(
      `Release tag "${tag}" must be a semantic version prefixed with "v", for example v0.1.0 or v0.1.0-alpha.1.`
    )
  }

  return tag.slice(1)
}

export function assertReleaseVersions(tag, packageVersions) {
  const releaseVersion = releaseVersionFromTag(tag)

  for (const [packageName, declaredVersion] of Object.entries(
    packageVersions
  )) {
    if (declaredVersion !== releaseVersion) {
      throw new Error(
        `${packageName} version ${declaredVersion} does not match release tag ${tag}.`
      )
    }
  }

  return releaseVersion
}

export async function packageVersion(packagePath) {
  const contents = await readFile(packagePath, "utf8")
  const parsed = JSON.parse(contents)

  if (typeof parsed.version !== "string") {
    throw new Error(`${packagePath} does not contain a string version.`)
  }

  return parsed.version
}

export async function collectReleaseArtifacts(inputDirectory, outputDirectory) {
  const outputEntries = await readdir(outputDirectory).catch((error) => {
    if (error?.code === "ENOENT") return []
    throw error
  })

  if (outputEntries.length > 0) {
    throw new Error(
      `Release output directory must be empty: ${outputDirectory}`
    )
  }

  await mkdir(outputDirectory, { recursive: true })

  const candidates = await filesWithin(inputDirectory)
  const distributables = candidates.filter((filePath) =>
    DISTRIBUTABLE_EXTENSIONS.has(path.extname(filePath).toLowerCase())
  )

  if (distributables.length === 0) {
    throw new Error(`No release artifacts found beneath ${inputDirectory}.`)
  }

  const copiedNames = new Set()

  for (const artifactPath of distributables.sort()) {
    const artifactName = path.basename(artifactPath)
    if (copiedNames.has(artifactName)) {
      throw new Error(
        `Multiple release artifacts share the filename ${artifactName}.`
      )
    }

    copiedNames.add(artifactName)
    await copyFile(artifactPath, path.join(outputDirectory, artifactName))
  }

  return [...copiedNames].sort()
}

export async function writeReleaseChecksums(directory, outputPath) {
  const outputName = path.basename(outputPath)
  const entries = await readdir(directory, { withFileTypes: true })
  const fileNames = entries
    .filter((entry) => entry.isFile() && entry.name !== outputName)
    .map((entry) => entry.name)
    .sort()

  if (fileNames.length === 0) {
    throw new Error(`No release artifacts found in ${directory}.`)
  }

  const checksums = []
  for (const fileName of fileNames) {
    const contents = await readFile(path.join(directory, fileName))
    const digest = createHash("sha256").update(contents).digest("hex")
    checksums.push(`${digest}  ${fileName}`)
  }

  await writeFile(outputPath, `${checksums.join("\n")}\n`, "utf8")
  return checksums
}

async function filesWithin(directory) {
  const directoryStats = await stat(directory).catch((error) => {
    if (error?.code === "ENOENT") {
      throw new Error(`Release artifact directory does not exist: ${directory}`)
    }
    throw error
  })

  if (!directoryStats.isDirectory()) {
    throw new Error(`Release artifact path is not a directory: ${directory}`)
  }

  const entries = await readdir(directory, { withFileTypes: true })
  const nestedFiles = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(directory, entry.name)
      if (entry.isDirectory()) return filesWithin(entryPath)
      if (entry.isFile()) return [entryPath]
      return []
    })
  )

  return nestedFiles.flat()
}

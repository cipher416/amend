import { shell } from "electron"

export async function moveWikiToTrash(wikiPath: string): Promise<void> {
  await shell.trashItem(wikiPath)
}

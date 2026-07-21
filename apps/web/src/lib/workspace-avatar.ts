export function workspaceAvatarDataUrl(workspaceId: string): string {
  const hue = hashToHue(workspaceId)
  const fromColor = `hsl(${hue} 72% 46%)`
  const toColor = `hsl(${(hue + 72) % 360} 72% 42%)`
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><linearGradient id="gradient" x1="0" y1="0" x2="1" y2="1"><stop stop-color="${fromColor}"/><stop offset="1" stop-color="${toColor}"/></linearGradient></defs><rect width="64" height="64" rx="18" fill="url(#gradient)"/></svg>`
  return `data:image/svg+xml,${encodeURIComponent(svg)}`
}

function hashToHue(seed: string): number {
  let hash = 2_166_136_261
  for (const character of seed) {
    hash ^= character.codePointAt(0) ?? 0
    hash = Math.imul(hash, 16_777_619)
  }
  return (hash >>> 0) % 360
}

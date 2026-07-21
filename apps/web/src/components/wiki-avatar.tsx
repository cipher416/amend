import { wikiAvatarDataUrl } from "@/lib/wiki-avatar"

export function WikiAvatar({
  wikiId,
  className,
}: {
  wikiId: string
  className?: string
}) {
  return (
    <img
      alt=""
      aria-hidden="true"
      className={className}
      decoding="async"
      src={wikiAvatarDataUrl(wikiId)}
    />
  )
}

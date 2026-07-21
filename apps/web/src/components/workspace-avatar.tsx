import { workspaceAvatarDataUrl } from "@/lib/workspace-avatar"

export function WorkspaceAvatar({
  workspaceId,
  className,
}: {
  workspaceId: string
  className?: string
}) {
  return (
    <img
      alt=""
      aria-hidden="true"
      className={className}
      decoding="async"
      src={workspaceAvatarDataUrl(workspaceId)}
    />
  )
}

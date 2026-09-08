import { Icon } from "@/components/ui/icon"
import { RiAddCircleLine } from "@remixicon/react"

export function NewChatIcon({
  size = 18,
  className,
}: {
  size?: number
  className?: string
}) {
  return <Icon icon={RiAddCircleLine} slotSize={size} className={className} />
}

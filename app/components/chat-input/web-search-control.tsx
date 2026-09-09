"use client"

import { ComposerControl } from "@/components/ui/composer-control"
import { Icon } from "@/components/ui/icon"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import type { SearchMode } from "@/lib/models/types"
import { cn } from "@/lib/utils"
import { RiCloseLine, RiGlobalLine, RiGlobalOffLine } from "@remixicon/react"
import { useState } from "react"

type WebSearchControlProps = {
  enabled: boolean
  mode: SearchMode
  onEnabledChange: (enabled: boolean) => void
  tooltipDisabled?: boolean
}

function getWebSearchControlState({
  enabled,
  mode,
}: Pick<WebSearchControlProps, "enabled" | "mode">) {
  if (mode === "always-on") {
    return {
      active: true,
      toggleable: false,
      tooltip: "Search is always on for this model",
    }
  }

  if (mode === "unsupported") {
    return {
      active: false,
      toggleable: false,
      tooltip: "This model doesn’t support web search",
    }
  }

  return {
    active: enabled,
    toggleable: true,
    tooltip: enabled ? "Click to disable search" : "Click to enable search",
  }
}

/** Two-row Composer search affordance. Search state never enters the draft. */
function WebSearchControl({
  enabled,
  mode,
  onEnabledChange,
  tooltipDisabled = false,
}: WebSearchControlProps) {
  const [canRevealDisableOnHover, setCanRevealDisableOnHover] = useState(true)
  const [pointerHovering, setPointerHovering] = useState(false)
  const { active, toggleable, tooltip } = getWebSearchControlState({
    enabled,
    mode,
  })
  const showDisableIcon =
    active && toggleable && canRevealDisableOnHover && pointerHovering
  const ariaLabel = toggleable
    ? `Search, ${tooltip.toLocaleLowerCase()}`
    : tooltip

  return (
    <Tooltip disabled={tooltipDisabled}>
      <TooltipTrigger
        render={
          <ComposerControl
            type="button"
            aria-label={ariaLabel}
            aria-pressed={active}
            data-web-search-control=""
            data-search-toggleable={toggleable ? "" : undefined}
            data-search-disable-hover={canRevealDisableOnHover ? "" : undefined}
            data-search-disable-visible={showDisableIcon ? "" : undefined}
            visuallyDisabled={!toggleable}
            className={cn(
              "web-search-control cant-hover:ps-2.5 cant-hover:pe-3.5 cant-hover:aria-pressed:bg-[var(--composer-capability-accent-hover-surface)]! hidden h-9 gap-1.5 py-0 ps-2 pe-3 text-sm/5 font-normal group-data-expanded/composer:inline-flex data-[visually-disabled]:opacity-100 max-sm:inline-flex @max-[520px]/main:inline-flex",
              active
                ? "text-[var(--composer-capability-accent)]"
                : "text-[var(--text-tertiary)]"
            )}
            onClick={() => {
              if (!active && pointerHovering) {
                setCanRevealDisableOnHover(false)
              }
              onEnabledChange(!active)
            }}
            onPointerEnter={(event) => {
              if (event.pointerType === "mouse") {
                setPointerHovering(true)
              }
            }}
            onPointerLeave={(event) => {
              if (event.pointerType === "mouse") {
                setPointerHovering(false)
                setCanRevealDisableOnHover(true)
              }
            }}
          >
            <Icon
              inert={true}
              data-search-control-icon=""
              data-search-icon={
                showDisableIcon ? "remove" : active ? "globe" : "off"
              }
              icon={
                showDisableIcon
                  ? RiCloseLine
                  : active
                    ? RiGlobalLine
                    : RiGlobalOffLine
              }
              slotSize={20}
              glyphSize={showDisableIcon ? 16 : undefined}
            />
            <span className="max-w-40 truncate max-[520px]:sr-only">
              Search
            </span>
            {active && toggleable ? (
              <Icon
                inert={true}
                data-search-touch-remove-icon=""
                className="cant-hover:order-1 cant-hover:-me-1 cant-hover:inline-flex hidden"
                icon={RiCloseLine}
                slotSize={20}
                glyphSize={16}
              />
            ) : null}
          </ComposerControl>
        }
      />
      <TooltipContent>{tooltip}</TooltipContent>
    </Tooltip>
  )
}

export { WebSearchControl }

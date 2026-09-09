/** @vitest-environment jsdom */

import { deriveAssistantTurnView } from "@/lib/chat-messages/assistant-turn"
import type { UIMessage } from "@ai-sdk/react"
import React, { act } from "react"
import { createRoot, Root } from "react-dom/client"
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest"
import { Message } from "./message"

// Render spy + last-received props, so memo-equality tests can observe whether
// the assistant body re-rendered and what props it received.
const messageAssistantSpy = vi.hoisted(() => vi.fn())
const lastAssistantProps = vi.hoisted(() => ({
  current: {} as Record<string, unknown>,
}))

vi.mock("./message-assistant", () => ({
  MessageAssistant: (props: {
    children: React.ReactNode
    messageId: string
    copied?: boolean
    copyToClipboard?: () => void
    onReload?: (messageId: string) => void
    retryModelId?: string
    retryDisabled?: boolean
  }) => {
    messageAssistantSpy()
    lastAssistantProps.current = props
    const { children, messageId, onReload } = props
    return (
      <div data-testid="assistant-shell">
        <div>{children}</div>
        <button
          data-copied={Boolean(props.copied)}
          data-testid="copy"
          type="button"
          onClick={props.copyToClipboard}
        >
          copy
        </button>
        <button
          data-can-reload={Boolean(onReload)}
          data-retry-disabled={Boolean(props.retryDisabled)}
          data-testid="reload"
          disabled={props.retryDisabled}
          type="button"
          onClick={() => onReload?.(messageId)}
        >
          reload
        </button>
      </div>
    )
  },
}))

vi.mock("./message-user", () => ({
  MessageUser: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}))

beforeAll(() => {
  ;(
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true
})

const EMPTY_VIEW = deriveAssistantTurnView({ parts: [] }, "ready")

describe("Message memoization", () => {
  let container: HTMLDivElement | null = null
  let root: Root | null = null

  afterEach(() => {
    const rootToUnmount = root
    if (rootToUnmount) {
      act(() => {
        rootToUnmount.unmount()
      })
    }
    container?.remove()
    root = null
    container = null
  })

  function renderMessage({
    id = "assistant-1",
    onReload,
    retryModelId,
    retryDisabled,
    isReplaying,
  }: {
    id?: string
    onReload?: (messageId: string) => void
    retryModelId?: string
    retryDisabled?: boolean
    isReplaying?: boolean
  } = {}) {
    if (!container) {
      container = document.createElement("div")
      document.body.appendChild(container)
      root = createRoot(container)
    }

    act(() => {
      root?.render(
        <Message
          model={{
            id,
            kind: "assistant",
            text: "Approve this tool",
            view: EMPTY_VIEW,
            retryModelId,
            retryDisabled,
          }}
          onEdit={() => {}}
          onReload={onReload}
          isReplaying={isReplaying}
        />
      )
    })
  }

  it("updates replay presentation when the message content is unchanged", () => {
    renderMessage({ isReplaying: true })
    expect(lastAssistantProps.current.isReplaying).toBe(true)
    renderMessage({ isReplaying: false })
    expect(lastAssistantProps.current.isReplaying).toBe(false)
  })

  it("updates assistant reload availability when only the callback presence changes", () => {
    const firstReloadHandler = vi.fn()
    const secondReloadHandler = vi.fn()

    renderMessage({ onReload: firstReloadHandler })
    renderMessage({ onReload: undefined })

    const reloadButton = container?.querySelector(
      '[data-testid="reload"]'
    ) as HTMLButtonElement | null

    expect(reloadButton).toBeTruthy()
    expect(reloadButton?.dataset.canReload).toBe("false")

    act(() => {
      reloadButton?.click()
    })

    expect(firstReloadHandler).not.toHaveBeenCalled()

    renderMessage({ onReload: secondReloadHandler })

    const updatedReloadButton = container?.querySelector(
      '[data-testid="reload"]'
    ) as HTMLButtonElement | null

    expect(updatedReloadButton?.dataset.canReload).toBe("true")

    act(() => {
      updatedReloadButton?.click()
    })

    expect(secondReloadHandler).toHaveBeenCalledWith("assistant-1")
  })

  it("updates the assistant retry model when only the selected model changes", () => {
    renderMessage({ retryModelId: "gpt-5.4-mini" })
    renderMessage({ retryModelId: "gpt-5.5" })

    expect(lastAssistantProps.current.retryModelId).toBe("gpt-5.5")
  })

  it("updates assistant retry interactivity when only its disabled state changes", () => {
    const onReload = vi.fn()

    renderMessage({ onReload, retryDisabled: true })

    const retry = container?.querySelector(
      '[data-testid="reload"]'
    ) as HTMLButtonElement | null
    expect(retry?.dataset.canReload).toBe("true")
    expect(retry?.dataset.retryDisabled).toBe("true")
    expect(retry?.disabled).toBe(true)

    renderMessage({ onReload, retryDisabled: false })

    expect(retry?.dataset.retryDisabled).toBe("false")
    expect(retry?.disabled).toBe(false)
  })

  it("preserves the assistant shell when the pending id adopts the streamed id", () => {
    renderMessage({ id: "__pending_activity_turn__" })
    const pendingShell = container?.querySelector(
      '[data-testid="assistant-shell"]'
    )

    renderMessage({ id: "assistant-1" })

    expect(
      container?.querySelector('[data-testid="assistant-shell"]')
    ).toBe(pendingShell)
  })
})

describe("Message body memo contract", () => {
  let container: HTMLDivElement | null = null
  let root: Root | null = null

  beforeEach(() => {
    messageAssistantSpy.mockClear()
    lastAssistantProps.current = {}
    container = document.createElement("div")
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    const rootToUnmount = root
    if (rootToUnmount) {
      act(() => {
        rootToUnmount.unmount()
      })
    }
    container?.remove()
    root = null
    container = null
  })

  function renderAssistant(props: {
    parts?: UIMessage["parts"]
    metadata?: unknown
    status?: "streaming" | "ready" | "submitted" | "error"
    isLast?: boolean
    children?: string
  }) {
    // Derive the view fresh each render — exactly what Conversation does. The
    // AI SDK mutates part objects in place, so the derivation must observe
    // mutations through the same parts reference.
    const view = deriveAssistantTurnView(
      { parts: props.parts, metadata: props.metadata },
      props.status ?? "ready"
    )
    act(() => {
      root?.render(
        <Message
          model={{
            id: "assistant-1",
            kind: "assistant",
            text: props.children ?? "",
            isLast: props.isLast,
            status: props.status,
            view,
          }}
          onEdit={() => {}}
        />
      )
    })
  }

  it("updates inline work when reasoning/source parts change during streaming", () => {
    const partsA = [
      { type: "reasoning", text: "thinking", state: "streaming" },
    ] as unknown as UIMessage["parts"]
    renderAssistant({
      parts: partsA,
      status: "streaming",
      isLast: true,
      children: "",
    })
    expect(messageAssistantSpy).toHaveBeenCalledTimes(1)

    const partsB = [
      { type: "reasoning", text: "thinking harder", state: "streaming" },
      {
        type: "source-url",
        sourceId: "s1",
        url: "https://example.com",
        title: "Example",
      },
    ] as unknown as UIMessage["parts"]
    renderAssistant({
      parts: partsB,
      status: "streaming",
      isLast: true,
      children: "",
    })

    // Inline work now renders these facts inside the assistant row.
    expect(messageAssistantSpy).toHaveBeenCalledTimes(2)
  })

  it("re-renders the body on a real text delta during streaming", () => {
    renderAssistant({
      parts: [{ type: "text", text: "Hi" }] as unknown as UIMessage["parts"],
      status: "streaming",
      isLast: true,
      children: "Hi",
    })
    expect(messageAssistantSpy).toHaveBeenCalledTimes(1)

    renderAssistant({
      parts: [
        { type: "text", text: "Hi there" },
      ] as unknown as UIMessage["parts"],
      status: "streaming",
      isLast: true,
      children: "Hi there",
    })
    expect(messageAssistantSpy).toHaveBeenCalledTimes(2)
  })

  it("copies the complete latest canonical response after settlement", async () => {
    const originalClipboard = Object.getOwnPropertyDescriptor(
      navigator,
      "clipboard"
    )
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    })

    try {
      const partial = Array.from(
        { length: 64 },
        (_, i) => `1. streamed item ${i + 1}`
      ).join("\n")
      const complete = Array.from(
        { length: 176 },
        (_, i) => `1. settled item ${i + 1}`
      ).join("\n")

      renderAssistant({
        parts: [
          { type: "text", text: partial },
        ] as unknown as UIMessage["parts"],
        status: "streaming",
        isLast: true,
        children: partial,
      })
      renderAssistant({
        parts: [
          { type: "text", text: complete },
        ] as unknown as UIMessage["parts"],
        status: "ready",
        isLast: true,
        children: complete,
      })

      const copyButton = container?.querySelector(
        '[data-testid="copy"]'
      ) as HTMLButtonElement | null
      await act(async () => {
        copyButton?.click()
        await Promise.resolve()
      })

      expect(writeText).toHaveBeenCalledTimes(1)
      expect(writeText).toHaveBeenCalledWith(complete)
      expect(writeText).not.toHaveBeenCalledWith(partial)
      expect(copyButton?.dataset.copied).toBe("true")
    } finally {
      if (originalClipboard) {
        Object.defineProperty(navigator, "clipboard", originalClipboard)
      } else {
        Reflect.deleteProperty(navigator, "clipboard")
      }
    }
  })

  it("keeps copy feedback idle when the clipboard is unavailable or rejects", async () => {
    const originalClipboard = Object.getOwnPropertyDescriptor(
      navigator,
      "clipboard"
    )

    try {
      renderAssistant({
        parts: [{ type: "text", text: "Canonical answer" }],
        status: "ready",
        children: "Canonical answer",
      })
      const copyButton = container?.querySelector(
        '[data-testid="copy"]'
      ) as HTMLButtonElement | null

      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: undefined,
      })
      await act(async () => {
        copyButton?.click()
        await Promise.resolve()
      })
      expect(copyButton?.dataset.copied).toBe("false")

      const writeText = vi.fn().mockRejectedValue(new Error("denied"))
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: { writeText },
      })
      await act(async () => {
        copyButton?.click()
        await Promise.resolve()
      })
      expect(writeText).toHaveBeenCalledWith("Canonical answer")
      expect(copyButton?.dataset.copied).toBe("false")
    } finally {
      if (originalClipboard) {
        Object.defineProperty(navigator, "clipboard", originalClipboard)
      } else {
        Reflect.deleteProperty(navigator, "clipboard")
      }
    }
  })

  it("lets only the latest repeated click publish copy feedback", async () => {
    const originalClipboard = Object.getOwnPropertyDescriptor(
      navigator,
      "clipboard"
    )
    let resolveFirst: (() => void) | undefined
    let resolveSecond: (() => void) | undefined
    const writeText = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            resolveFirst = resolve
          })
      )
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            resolveSecond = resolve
          })
      )
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    })

    try {
      renderAssistant({
        parts: [{ type: "text", text: "Canonical answer" }],
        status: "ready",
        children: "Canonical answer",
      })
      const copyButton = container?.querySelector(
        '[data-testid="copy"]'
      ) as HTMLButtonElement | null

      act(() => {
        copyButton?.click()
        copyButton?.click()
      })
      expect(writeText).toHaveBeenCalledTimes(2)

      await act(async () => {
        resolveFirst?.()
        await Promise.resolve()
      })
      expect(copyButton?.dataset.copied).toBe("false")

      await act(async () => {
        resolveSecond?.()
        await Promise.resolve()
      })
      expect(copyButton?.dataset.copied).toBe("true")
    } finally {
      if (originalClipboard) {
        Object.defineProperty(navigator, "clipboard", originalClipboard)
      } else {
        Reflect.deleteProperty(navigator, "clipboard")
      }
    }
  })

  it("invalidates an in-flight copy when canonical text changes", async () => {
    const originalClipboard = Object.getOwnPropertyDescriptor(
      navigator,
      "clipboard"
    )
    let resolvePartial: (() => void) | undefined
    const writeText = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            resolvePartial = resolve
          })
      )
      .mockResolvedValueOnce(undefined)
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    })

    try {
      renderAssistant({
        parts: [{ type: "text", text: "Partial answer" }],
        status: "ready",
        children: "Partial answer",
      })
      const copyButton = container?.querySelector(
        '[data-testid="copy"]'
      ) as HTMLButtonElement | null
      act(() => {
        copyButton?.click()
      })

      renderAssistant({
        parts: [{ type: "text", text: "Complete answer" }],
        status: "ready",
        children: "Complete answer",
      })
      await act(async () => {
        resolvePartial?.()
        await Promise.resolve()
      })
      expect(copyButton?.dataset.copied).toBe("false")

      await act(async () => {
        copyButton?.click()
        await Promise.resolve()
      })
      expect(writeText).toHaveBeenLastCalledWith("Complete answer")
      expect(copyButton?.dataset.copied).toBe("true")
    } finally {
      if (originalClipboard) {
        Object.defineProperty(navigator, "clipboard", originalClipboard)
      } else {
        Reflect.deleteProperty(navigator, "clipboard")
      }
    }
  })

  it("re-renders the body when rendered tool input/output mutate in place", () => {
    const parts = [
      {
        type: "tool-search",
        toolCallId: "tool-call-1",
        state: "input-streaming",
        input: { query: "new" },
      },
    ] as unknown as UIMessage["parts"]
    const mutable = parts as unknown as Array<{
      state: "input-streaming" | "output-available"
      input: { query: string }
      output?: { summary: string; temperature?: string }
    }>

    renderAssistant({
      parts,
      status: "streaming",
      isLast: true,
      children: "",
    })
    expect(messageAssistantSpy).toHaveBeenCalledTimes(1)

    mutable[0].input.query = "new york weather"
    renderAssistant({
      parts,
      status: "streaming",
      isLast: true,
      children: "",
    })
    expect(messageAssistantSpy).toHaveBeenCalledTimes(2)

    const output: { summary: string; temperature?: string } = {
      summary: "Cloudy",
    }
    mutable[0].state = "output-available"
    mutable[0].output = output
    renderAssistant({
      parts,
      status: "streaming",
      isLast: true,
      children: "",
    })
    expect(messageAssistantSpy).toHaveBeenCalledTimes(3)

    output.temperature = "72 F"
    renderAssistant({
      parts,
      status: "streaming",
      isLast: true,
      children: "",
    })
    expect(messageAssistantSpy).toHaveBeenCalledTimes(4)
  })

  it("re-renders when the metadata identity changes (durable adoption)", () => {
    const parts = [
      { type: "text", text: "Answer" },
    ] as unknown as UIMessage["parts"]

    renderAssistant({
      parts,
      status: "ready",
      isLast: true,
      children: "Answer",
    })
    expect(messageAssistantSpy).toHaveBeenCalledTimes(1)

    // The metadata writers return a NEW object when server-owned keys change
    // (and the same reference on no-op), so identity is the change signal.
    renderAssistant({
      parts,
      metadata: { serverMessageId: "server-1", reasoningDurationMs: 2000 },
      status: "ready",
      isLast: true,
      children: "Answer",
    })
    expect(messageAssistantSpy).toHaveBeenCalledTimes(2)
  })
})

/** @vitest-environment jsdom */

import { projectSelectedPath } from "@/lib/chat-store/turns/selected-path"
import {
  createChatTurnController,
  type ChatTurnAdapters,
  type ChatTurnMessage,
} from "@/lib/chat-turn/chat-turn-controller"
import { useChat, type UIMessage } from "@ai-sdk/react"
import {
  createUIMessageStream,
  createUIMessageStreamResponse,
  DefaultChatTransport,
  type UIMessageStreamWriter,
} from "ai"
import React, { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { Conversation } from "./conversation"
import { PENDING_ACTIVITY_TURN_ID } from "./use-activity-panel"

const HOUR = 60 * 60 * 1000
const turnScrollMocks = vi.hoisted(() => {
  const centerObserver = {
    observe: () => () => undefined,
    disconnect: () => undefined,
  }
  return { centerObserver }
})

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve
  })
  return { promise, resolve }
}

vi.mock("@/components/ui/message", () => ({
  Message: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}))

vi.mock("@/lib/chat-store/messages/api", () => ({
  cacheMessages: vi.fn(async () => {}),
  getCachedMessages: vi.fn(async () => []),
}))

vi.mock("@/hooks/use-breakpoint", () => ({ useBreakpoint: () => false }))

vi.mock("./thread-scroll", () => ({
  ThreadScrollEdge: ({
    streamActive,
    scrollTarget,
  }: {
    streamActive: boolean
    scrollTarget?: { turnId: string; messageId?: string } | null
  }) => (
    <div
      data-scroll-target={
        scrollTarget
          ? `${scrollTarget.turnId}:${scrollTarget.messageId ?? ""}`
          : undefined
      }
      data-stream-active={streamActive}
      data-testid="thread-scroll-edge"
    />
  ),
  useSubmitTurnScrollRef: (active: boolean) => (node: HTMLElement | null) => {
    if (node) node.dataset.submitScrollActive = String(active)
  },
  useConversationTurnObservation: () => {
    return {
      centerIntersectionObserver: turnScrollMocks.centerObserver,
      markerRef: () => undefined,
    }
  },
}))

vi.mock("@/components/ui/thinking-bar", () => ({
  ThinkingBar: () => <div data-testid="thinking" />,
}))

vi.mock("./message", () => ({
  Message: ({
    model,
    onEditingChange,
    onReload,
  }: {
    model: {
      id: string
      kind: "assistant" | "user" | "unsupported"
      text: string
      isEditing?: boolean
      status?: string
      finishReason?: string
      retryDisabled?: boolean
      view?: { reasoning?: { phase?: string } }
    }
    onEditingChange?: (messageId: string, isEditing: boolean) => void
    onReload?: (messageId: string) => void
  }) => (
    <>
      <button
        data-can-reload={Boolean(onReload)}
        data-finish-reason={model.finishReason}
        data-reasoning-phase={model.view?.reasoning?.phase}
        data-retry-disabled={Boolean(model.retryDisabled)}
        data-status={model.status}
        data-testid={`message-${model.id}`}
        disabled={model.retryDisabled}
        onClick={() => onReload?.(model.id)}
        type="button"
      >
        {model.text}
      </button>
      {model.kind === "user" ? (
        <button
          data-testid={`toggle-edit-${model.id}`}
          onClick={() => onEditingChange?.(model.id, !Boolean(model.isEditing))}
          type="button"
        >
          Toggle edit
        </button>
      ) : null}
    </>
  ),
}))

beforeAll(() => {
  ;(
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true
})

describe("Conversation recovered turn contracts", () => {
  let container: HTMLDivElement | null = null
  let root: Root | null = null
  const messages = [
    {
      id: "user-1",
      role: "user",
      parts: [{ type: "text", text: "Prompt" }],
    },
    {
      id: "assistant-1",
      role: "assistant",
      parts: [{ type: "text", text: "Answer" }],
    },
  ] satisfies UIMessage[]

  afterEach(() => {
    act(() => root?.unmount())
    container?.remove()
    container = null
    root = null
    vi.unstubAllGlobals()
  })

  function render(scrollToMessageId?: string, chatId?: string) {
    if (!container) {
      container = document.createElement("div")
      document.body.append(container)
      root = createRoot(container)
    }
    act(() => {
      root?.render(
        <Conversation
          messages={messages}
          chatId={chatId}
          scrollToMessageId={scrollToMessageId}
          onEdit={vi.fn()}
          onReload={vi.fn()}
        />
      )
    })
  }

  it("reserves the fixed composer and keyboard below thread content", () => {
    render()

    expect(
      container?.querySelector('[data-testid="thread-scroll-edge"]')
        ?.parentElement?.className
    ).toContain(
      "keyboard-open:pb-[calc(var(--composer-height,100px)+var(--screen-keyboard-height,0))]"
    )
    expect(
      container?.querySelector('[data-testid="thread-scroll-edge"]')
        ?.parentElement?.className
    ).toContain("grow")
  })

  it("puts the edit-only 40px separation on the user turn-message owner", () => {
    render()

    const userOwner = () =>
      container?.querySelector<HTMLElement>(
        '[data-turn="user"] [data-conversation-screenshot-content]'
      )
    const assistantOwner = container?.querySelector<HTMLElement>(
      '[data-turn="assistant"] [data-conversation-screenshot-content]'
    )

    expect(userOwner()?.classList.contains("mb-10")).toBe(false)
    expect(assistantOwner?.classList.contains("mb-10")).toBe(false)

    act(() => {
      container
        ?.querySelector<HTMLButtonElement>('[data-testid="toggle-edit-user-1"]')
        ?.click()
    })

    expect(userOwner()?.classList.contains("mb-10")).toBe(true)
    expect(assistantOwner?.classList.contains("mb-10")).toBe(false)
  })

  it("drops the open editor when the mounted Conversation changes chat", () => {
    render(undefined, "chat-a")
    const editing = () =>
      container
        ?.querySelector<HTMLElement>(
          '[data-turn="user"] [data-conversation-screenshot-content]'
        )
        ?.classList.contains("mb-10")

    act(() => {
      container
        ?.querySelector<HTMLButtonElement>('[data-testid="toggle-edit-user-1"]')
        ?.click()
    })
    expect(editing()).toBe(true)

    render(undefined, "chat-b")
    expect(editing()).toBe(false)

    render(undefined, "chat-a")
    expect(editing()).toBe(false)
  })

  it("preserves assistant deep-link sentinels", () => {
    render("finalAgentTurnStart")
    expect(
      container
        ?.querySelector('[data-testid="thread-scroll-edge"]')
        ?.getAttribute("data-scroll-target")
    ).toBe("assistant-turn:user-1:")

    render("assistant-1")
    expect(
      container
        ?.querySelector('[data-testid="thread-scroll-edge"]')
        ?.getAttribute("data-scroll-target")
    ).toBe("assistant-turn:user-1:assistant-1")
  })

  it("preserves the turn wrapper and sizing rules when streaming settles", () => {
    const twoTurns = [
      { id: "user-1", role: "user", parts: [{ type: "text", text: "One" }] },
      {
        id: "assistant-1",
        role: "assistant",
        parts: [{ type: "text", text: "First answer" }],
      },
      { id: "user-2", role: "user", parts: [{ type: "text", text: "Two" }] },
      {
        id: "assistant-2",
        role: "assistant",
        parts: [{ type: "text", text: "Streaming answer" }],
      },
    ] satisfies UIMessage[]

    container = document.createElement("div")
    document.body.append(container)
    root = createRoot(container)
    const renderWithStatus = (status: "streaming" | "ready") =>
      act(() => {
        root?.render(
          <Conversation
            messages={twoTurns}
            status={status}
            onEdit={vi.fn()}
            onReload={vi.fn()}
          />
        )
      })

    renderWithStatus("streaming")
    const sections = () =>
      Array.from(
        container?.querySelectorAll<HTMLElement>(
          'section[data-turn="assistant"]'
        ) ?? []
      )
    expect(sections()).toHaveLength(2)
    const liveTurn = sections()[1]
    const liveClassName = liveTurn.className

    renderWithStatus("ready")
    expect(sections()[1]).toBe(liveTurn)
    expect(liveTurn.className).toBe(liveClassName)
    for (const section of sections()) {
      expect(section.className).not.toContain("content-visibility")
      expect(section.className).not.toContain("contain-intrinsic-size")
    }
  })
})

describe("Conversation regeneration availability", () => {
  let container: HTMLDivElement | null = null
  let root: Root | null = null

  function cleanupRender() {
    const mountedRoot = root
    if (mountedRoot) {
      act(() => mountedRoot.unmount())
    }
    container?.remove()
    root = null
    container = null
  }

  afterEach(cleanupRender)

  const messages = [
    {
      id: "user-1",
      role: "user",
      parts: [{ type: "text", text: "first prompt" }],
    },
    {
      id: "assistant-1",
      role: "assistant",
      parts: [{ type: "text", text: "first answer" }],
    },
    {
      id: "user-2",
      role: "user",
      parts: [{ type: "text", text: "second prompt" }],
    },
    {
      id: "assistant-2",
      role: "assistant",
      parts: [{ type: "text", text: "streaming answer" }],
    },
  ] satisfies UIMessage[]

  function renderConversation({
    status = "ready",
    isSubmitting = false,
    onReload = vi.fn(),
  }: {
    status?: "streaming" | "ready" | "submitted" | "error"
    isSubmitting?: boolean
    onReload?: (messageId: string) => void
  } = {}) {
    cleanupRender()
    const mounted = document.createElement("div")
    document.body.appendChild(mounted)
    container = mounted
    root = createRoot(mounted)

    act(() => {
      root?.render(
        <Conversation
          messages={messages}
          status={status}
          isSubmitting={isSubmitting}
          onEdit={vi.fn()}
          onReload={onReload}
          isDurableChat
        />
      )
    })

    return onReload
  }

  it("keeps prior retry actions visible but disabled while a generation is active", () => {
    const onReload = renderConversation({ status: "streaming" })
    const priorAssistant = container?.querySelector(
      '[data-testid="message-assistant-1"]'
    ) as HTMLButtonElement | null

    expect(priorAssistant?.dataset.canReload).toBe("true")
    expect(priorAssistant?.dataset.retryDisabled).toBe("true")
    expect(priorAssistant?.disabled).toBe(true)

    act(() => {
      priorAssistant?.click()
    })

    expect(onReload).not.toHaveBeenCalled()
  })

  it("keeps prior retry actions visible but disabled during submit preflight", () => {
    const onReload = renderConversation({ isSubmitting: true })
    const priorAssistant = container?.querySelector(
      '[data-testid="message-assistant-1"]'
    ) as HTMLButtonElement | null

    expect(priorAssistant?.dataset.canReload).toBe("true")
    expect(priorAssistant?.dataset.retryDisabled).toBe("true")
    expect(priorAssistant?.disabled).toBe(true)

    act(() => {
      priorAssistant?.click()
    })

    expect(onReload).not.toHaveBeenCalled()
  })

  it("exposes reload handlers when the chat is idle", () => {
    const onReload = renderConversation()
    const priorAssistant = container?.querySelector(
      '[data-testid="message-assistant-1"]'
    ) as HTMLButtonElement | null

    expect(priorAssistant?.dataset.canReload).toBe("true")
    expect(priorAssistant?.dataset.retryDisabled).toBe("false")
    expect(priorAssistant?.disabled).toBe(false)

    act(() => {
      priorAssistant?.click()
    })

    expect(onReload).toHaveBeenCalledWith("assistant-1")
  })

  it("matches the reference turn sections and vertical rhythm", () => {
    renderConversation()

    const turns = Array.from(
      container?.querySelectorAll<HTMLElement>(
        '[data-testid^="conversation-turn-"]'
      ) ?? []
    )

    expect(turns).toHaveLength(4)
    expect(turns.every((turn) => turn.tagName === "SECTION")).toBe(true)
    const padding = turns.map((turn) =>
      turn.querySelector<HTMLElement>(":scope > div")
    )
    expect(turns[0]?.querySelector(":scope > h4")?.textContent).toBe(
      "You said:"
    )
    expect(padding[0]?.classList.contains("pt-3")).toBe(true)
    expect(padding[0]?.classList.contains("pt-12")).toBe(false)
    expect(padding[2]?.classList.contains("pt-12")).toBe(true)
    expect(padding[3]?.classList.contains("pb-8")).toBe(true)
    expect(padding[3]?.classList.contains("pb-10")).toBe(false)
    // Wrapper-free eager shape: the section IS the turn owner; no ancestor
    // carries a duplicate turn id.
    expect(
      turns.every(
        (turn) => turn.parentElement?.dataset.turnIdContainer === undefined
      )
    ).toBe(true)
  })

  it("hydrates finish reasons from durable metadata for historical and last rows", () => {
    cleanupRender()
    const mounted = document.createElement("div")
    document.body.appendChild(mounted)
    container = mounted
    root = createRoot(mounted)

    const durableMessages = messages.map((message) =>
      message.role === "assistant"
        ? {
            ...message,
            metadata: {
              finishReason:
                message.id === "assistant-1" ? "length" : "content-filter",
            },
          }
        : message
    ) satisfies UIMessage[]

    act(() => {
      root?.render(
        <Conversation
          messages={durableMessages}
          status="ready"
          lastFinishReason="stop"
          onEdit={vi.fn()}
          onReload={vi.fn()}
          isDurableChat
        />
      )
    })

    expect(
      (
        container?.querySelector(
          '[data-testid="message-assistant-1"]'
        ) as HTMLButtonElement | null
      )?.dataset.finishReason
    ).toBe("length")
    expect(
      (
        container?.querySelector(
          '[data-testid="message-assistant-2"]'
        ) as HTMLButtonElement | null
      )?.dataset.finishReason
    ).toBe("content-filter")
  })

  it("routes the submitted pre-stream state through the activity assistant row", () => {
    cleanupRender()
    const mounted = document.createElement("div")
    document.body.appendChild(mounted)
    container = mounted
    root = createRoot(mounted)

    const userTail = [
      { id: "user-1", role: "user", parts: [{ type: "text", text: "hi" }] },
    ] satisfies UIMessage[]

    act(() => {
      root?.render(
        <Conversation
          messages={userTail}
          status="submitted"
          isSubmitting
          onEdit={vi.fn()}
          onReload={vi.fn()}
          isDurableChat
        />
      )
    })

    const pendingMessage = container?.querySelector(
      `[data-testid="message-${PENDING_ACTIVITY_TURN_ID}"]`
    ) as HTMLButtonElement | null

    expect(container?.querySelector('[data-testid="thinking"]')).toBeNull()
    expect(pendingMessage).toBeTruthy()
    expect(pendingMessage?.dataset.status).toBe("submitted")
  })

  it("routes submit preflight through the activity assistant row before status flips", () => {
    cleanupRender()
    const mounted = document.createElement("div")
    document.body.appendChild(mounted)
    container = mounted
    root = createRoot(mounted)

    const userTail = [
      { id: "user-1", role: "user", parts: [{ type: "text", text: "hi" }] },
    ] satisfies UIMessage[]

    act(() => {
      root?.render(
        <Conversation
          messages={userTail}
          status="ready"
          isSubmitting
          onEdit={vi.fn()}
          onReload={vi.fn()}
          isDurableChat
        />
      )
    })

    const pendingMessage = container?.querySelector(
      `[data-testid="message-${PENDING_ACTIVITY_TURN_ID}"]`
    ) as HTMLButtonElement | null

    expect(container?.querySelector('[data-testid="thinking"]')).toBeNull()
    expect(pendingMessage).toBeTruthy()
    expect(pendingMessage?.dataset.status).toBe("submitted")
  })

  it("keeps the pending row while an adopted assistant shell has no renderable evidence", () => {
    cleanupRender()
    const mounted = document.createElement("div")
    document.body.appendChild(mounted)
    container = mounted
    root = createRoot(mounted)

    const adoptedEmptyAssistant = [
      { id: "user-1", role: "user", parts: [{ type: "text", text: "hi" }] },
      { id: "assistant-1", role: "assistant", parts: [] },
    ] satisfies UIMessage[]

    act(() => {
      root?.render(
        <Conversation
          messages={adoptedEmptyAssistant}
          status="ready"
          isSubmitting
          onEdit={vi.fn()}
          onReload={vi.fn()}
          isDurableChat
        />
      )
    })

    expect(
      container?.querySelector(
        `[data-testid="message-${PENDING_ACTIVITY_TURN_ID}"]`
      )
    ).toBeTruthy()
    expect(
      container?.querySelector('[data-testid="message-assistant-1"]')
    ).toBeNull()
    expect(container?.querySelectorAll('[data-turn="assistant"]')).toHaveLength(
      1
    )
  })

  it("pins the optimistic user turn during submission before response text", () => {
    cleanupRender()
    const mounted = document.createElement("div")
    document.body.appendChild(mounted)
    container = mounted
    root = createRoot(mounted)

    const userTail = [
      { id: "user-1", role: "user", parts: [{ type: "text", text: "hi" }] },
    ] satisfies UIMessage[]

    act(() => {
      root?.render(
        <Conversation
          messages={userTail}
          status="submitted"
          onEdit={vi.fn()}
          onReload={vi.fn()}
          isDurableChat
        />
      )
    })

    const scrollEdge = container?.querySelector(
      '[data-testid="thread-scroll-edge"]'
    ) as HTMLDivElement | null

    expect(scrollEdge?.dataset.streamActive).toBe("true")
    expect(
      container
        ?.querySelector('[data-turn="user"]')
        ?.getAttribute("data-submit-scroll-active")
    ).toBe("true")
  })

  it("keeps the same user pin target when assistant streaming begins", () => {
    cleanupRender()
    const mounted = document.createElement("div")
    document.body.appendChild(mounted)
    container = mounted
    root = createRoot(mounted)

    const streamingTail = [
      { id: "user-1", role: "user", parts: [{ type: "text", text: "hi" }] },
      {
        id: "assistant-1",
        role: "assistant",
        parts: [{ type: "text", text: "hello" }],
      },
    ] satisfies UIMessage[]

    act(() => {
      root?.render(
        <Conversation
          messages={streamingTail.slice(0, 1)}
          status="submitted"
          onEdit={vi.fn()}
          onReload={vi.fn()}
          isDurableChat
        />
      )
    })
    act(() => {
      root?.render(
        <Conversation
          messages={streamingTail}
          status="streaming"
          onEdit={vi.fn()}
          onReload={vi.fn()}
          isDurableChat
        />
      )
    })

    const scrollEdge = container?.querySelector(
      '[data-testid="thread-scroll-edge"]'
    ) as HTMLDivElement | null

    expect(scrollEdge?.dataset.streamActive).toBe("true")
    expect(
      container
        ?.querySelector('[data-turn="user"]')
        ?.getAttribute("data-submit-scroll-active")
    ).toBe("true")
  })

  it("never arms resumed streams, but arms later local regeneration and resets across chats", () => {
    cleanupRender()
    const mounted = document.createElement("div")
    document.body.appendChild(mounted)
    container = mounted
    root = createRoot(mounted)
    const messages = [
      { id: "user-1", role: "user", parts: [{ type: "text", text: "hi" }] },
      {
        id: "assistant-1",
        role: "assistant",
        parts: [{ type: "text", text: "hello" }],
      },
    ] satisfies UIMessage[]
    const render = (
      status: "streaming" | "ready" | "submitted",
      chatId: string | null = "chat-1",
      isSubmitting = false,
      nextMessages: UIMessage[] = messages
    ) => {
      act(() =>
        root?.render(
          <Conversation
            chatId={chatId}
            messages={nextMessages}
            status={status}
            isSubmitting={isSubmitting}
            onEdit={vi.fn()}
            onReload={vi.fn()}
            onCenterIntersectionChange={vi.fn()}
          />
        )
      )
      return container
        ?.querySelector('[data-turn="user"]')
        ?.getAttribute("data-submit-scroll-active")
    }

    expect(render("streaming")).toBe("false")
    // Changed observer callbacks reattach TurnRow's combined ref.
    expect(render("streaming")).toBe("false")
    expect(render("ready")).toBe("false")
    expect(render("ready", "chat-1", true)).toBe("true")
    expect(render("submitted")).toBe("true")
    expect(render("streaming")).toBe("true")
    expect(render("ready")).toBe("false")
    expect(render("submitted")).toBe("true")
    expect(render("streaming", "chat-2")).toBe("false")
    expect(render("ready")).toBe("false")
    const nextUser = [
      { id: "user-2", role: "user", parts: [{ type: "text", text: "next" }] },
    ] satisfies UIMessage[]
    expect(render("submitted", "chat-1", false, nextUser)).toBe("true")
    expect(render("submitted", null, false, nextUser)).toBe("true")
    expect(render("streaming", "new-chat", false, nextUser)).toBe("true")
  })

  it("keeps historical assistant views ready while the current assistant streams", () => {
    cleanupRender()
    const mounted = document.createElement("div")
    document.body.appendChild(mounted)
    container = mounted
    root = createRoot(mounted)

    const opaqueReasoningMessages = [
      {
        id: "user-1",
        role: "user",
        parts: [{ type: "text", text: "first prompt" }],
      },
      {
        id: "assistant-1",
        role: "assistant",
        parts: [
          { type: "reasoning", text: "" },
          { type: "text", text: "first answer" },
        ],
      },
      {
        id: "user-2",
        role: "user",
        parts: [{ type: "text", text: "second prompt" }],
      },
      {
        id: "assistant-2",
        role: "assistant",
        parts: [{ type: "reasoning", text: "" }],
      },
    ] satisfies UIMessage[]

    act(() => {
      root?.render(
        <Conversation
          messages={opaqueReasoningMessages}
          status="streaming"
          onEdit={vi.fn()}
          onReload={vi.fn()}
          isDurableChat
        />
      )
    })

    const priorAssistant = container?.querySelector(
      '[data-testid="message-assistant-1"]'
    ) as HTMLButtonElement | null
    const currentAssistant = container?.querySelector(
      '[data-testid="message-assistant-2"]'
    ) as HTMLButtonElement | null

    expect(priorAssistant?.dataset.reasoningPhase).toBe("complete")
    expect(currentAssistant?.dataset.reasoningPhase).toBe("thinking")
  })
})

describe("Conversation optimistic-to-durable timestamp lifecycle", () => {
  type TimestampedUIMessage = UIMessage & { createdAt?: Date }
  type LifecycleApi = {
    messages: TimestampedUIMessage[]
    reconcile: (serverPath: ChatTurnMessage[]) => void
    send: () => Promise<void>
    status: "streaming" | "ready" | "submitted" | "error"
  }

  const now = new Date("2026-07-09T16:00:00.000Z")
  let container: HTMLDivElement | null = null
  let root: Root | null = null

  afterEach(() => {
    vi.unstubAllGlobals()
    const mountedRoot = root
    if (mountedRoot) act(() => mountedRoot.unmount())
    container?.remove()
    container = null
    root = null
  })

  async function waitFor(assertion: () => void) {
    let lastError: unknown
    for (let attempt = 0; attempt < 80; attempt++) {
      try {
        assertion()
        return
      } catch (error) {
        lastError = error
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 0))
        })
      }
    }
    throw lastError
  }

  function mountLifecycle(qualifies: boolean) {
    const authGate = deferred<string | null>()
    const uploadGate = deferred<Array<{
      attachmentId: string
      contentType: string
      name: string
      url: string
    }> | null>()
    const streamGate = deferred<void>()
    const apiRef: { current: LifecycleApi | null } = { current: null }
    let streamWriter: UIMessageStreamWriter<UIMessage> | undefined
    let isSending = false

    const initialAssistant: TimestampedUIMessage = {
      id: "assistant-before-send",
      role: "assistant",
      createdAt: new Date(
        now.getTime() - (qualifies ? 2 * HOUR : 30 * 60 * 1000)
      ),
      parts: [{ type: "text", text: "Earlier answer" }],
    }
    const response = createUIMessageStreamResponse({
      stream: createUIMessageStream({
        execute: async ({ writer }) => {
          streamWriter = writer
          await streamGate.promise
        },
      }),
    })
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response)
    )

    function Harness() {
      const [isSubmitting, setIsSubmitting] = React.useState(false)
      const [transport] = React.useState(
        () => new DefaultChatTransport({ api: "/api/chat" })
      )
      const chat = useChat<TimestampedUIMessage>({
        messages: [initialAssistant],
        transport,
      })

      const send = async () => {
        const adapters: ChatTurnAdapters = {
          now: () => now,
          createOptimisticMessageId: () => "optimistic-user",
          getTurnSnapshot: () => ({
            enableSearch: false,
            isAuthenticated: true,
            selectedModel: "fixture-model",
            systemPrompt: "fixture system prompt",
          }),
          getCurrentChatId: () => "chat-durable",
          firstTurn: { begin: () => "chat-durable", rollback: () => {} },
          getIsSending: () => isSending,
          setIsSending: (value) => {
            isSending = value
          },
          setIsSubmitting,
          setHasSentFirstMessage: vi.fn(),
          setMessages: chat.setMessages,
          resolveUserId: () => authGate.promise,
          checkLimitsAndNotify: vi.fn(async () => true),
          ensureChatExists: vi.fn(async () => ({ chatId: "chat-durable" })),
          setPreviousChatId: vi.fn(),
          cleanupOptimisticAttachments: vi.fn(),
          attachStagedFiles: () => uploadGate.promise,
          sendMessage: chat.sendMessage,
          sendMessageAndWaitForAcceptance: (...args) => {
            void chat.sendMessage(...args)
            return Promise.resolve()
          },
          regenerate: chat.regenerate,
          toastError: vi.fn(),
          bumpChat: vi.fn(),
          setLastFinishReason: vi.fn(),
          reportError: vi.fn(),
          store: {
            isAuthenticated: () => true,
            updateMessages: chat.setMessages,
            cacheAndAddMessage: vi.fn(),
            updateTitle: vi.fn(),
            pendingEdit: {
              get: () => null,
              stage: vi.fn(),
              clear: vi.fn(),
            },
            getStoredGuestChatId: () => null,
            reportError: vi.fn(),
          },
        }
        const controller = createChatTurnController(adapters)
        await controller.runSendTurn({
          chatVersion: 2,
          messages: [initialAssistant],
          optimisticAttachments: [
            {
              contentType: "application/pdf",
              name: "notes.pdf",
              url: "blob:optimistic-notes",
            },
          ],
          submittedFiles: [
            new File(["fixture"], "notes.pdf", {
              type: "application/pdf",
            }),
          ],
          submittedAttachments: [
            {
              attachmentId: "attachment-1",
              contentType: "application/pdf",
              name: "notes.pdf",
              url: "/api/files/attachment-1/preview",
            },
          ],
          text: "New prompt",
        })
      }

      React.useLayoutEffect(() => {
        apiRef.current = {
          messages: chat.messages,
          reconcile: (serverPath) => {
            chat.setMessages(
              (live) =>
                projectSelectedPath(
                  live as ChatTurnMessage[],
                  serverPath
                ) as TimestampedUIMessage[]
            )
          },
          send,
          status: chat.status,
        }
      })

      return (
        <Conversation
          isDurableChat
          isSubmitting={isSubmitting}
          messages={chat.messages}
          now={now}
          onEdit={vi.fn()}
          onReload={vi.fn()}
          status={chat.status}
        />
      )
    }

    container = document.createElement("div")
    document.body.appendChild(container)
    root = createRoot(container)
    act(() => root?.render(<Harness />))

    return {
      apiRef,
      authGate,
      getStreamWriter: () => streamWriter,
      initialAssistant,
      streamGate,
      uploadGate,
    }
  }

  function assertLifecycleFrame(
    api: LifecycleApi,
    expectedSeparatorCount: 0 | 1,
    originalWrapper?: Element
  ): Element {
    const user = api.messages.find(
      (message) => message.id === "optimistic-user"
    )
    expect(user?.role).toBe("user")
    expect(user?.createdAt).toBeInstanceOf(Date)
    expect(Number.isFinite(user?.createdAt?.getTime())).toBe(true)

    const rows = container?.querySelectorAll<HTMLElement>(
      '[data-turn-id-container="optimistic-user"]'
    )
    expect(rows).toHaveLength(1)
    const wrapper = rows?.[0]
    expect(wrapper).toBeTruthy()
    expect(wrapper?.tagName).toBe("SECTION")
    expect(wrapper?.getAttribute("data-turn")).toBe("user")
    if (originalWrapper) expect(wrapper).toBe(originalWrapper)

    const separators = container?.querySelectorAll('[role="separator"]')
    expect(separators).toHaveLength(expectedSeparatorCount)
    if (expectedSeparatorCount === 1) {
      const separator = separators?.[0]
      // The timestamp separator renders as the section's preceding sibling
      // (TurnRow's beforeTurn fragment) — never inside a turn.
      expect(wrapper?.previousElementSibling).toBe(separator)
      expect(separator?.closest("[data-turn]")).toBeNull()
    }

    return wrapper as Element
  }

  async function runLifecycle(qualifies: boolean) {
    const lifecycle = mountLifecycle(qualifies)
    const api = () => {
      if (!lifecycle.apiRef.current)
        throw new Error("Lifecycle API unavailable")
      return lifecycle.apiRef.current
    }

    let sendPromise!: Promise<void>
    act(() => {
      sendPromise = api().send()
    })

    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(
      api().messages.some((message) => message.id === "optimistic-user")
    ).toBe(true)
    const immediateUser = api().messages.find(
      (message) => message.id === "optimistic-user"
    )
    expect(immediateUser?.parts).toContainEqual(
      expect.objectContaining({ url: "blob:optimistic-notes" })
    )
    const originalWrapper = assertLifecycleFrame(api(), qualifies ? 1 : 0)
    const originalTurn = originalWrapper
    const originalSeparator = qualifies
      ? originalWrapper.previousElementSibling
      : null
    const assistantTurns = container?.querySelectorAll(
      '[data-turn="assistant"]'
    )
    const pendingAssistant = assistantTurns?.item(
      (assistantTurns?.length ?? 1) - 1
    )
    expect(pendingAssistant).toBeTruthy()
    expect(pendingAssistant?.querySelector('[role="separator"]')).toBeNull()
    const pendingAssistantWrapper = pendingAssistant?.closest(
      "[data-turn-id-container]"
    )
    expect(pendingAssistantWrapper).toBeTruthy()

    await act(async () => {
      lifecycle.authGate.resolve("fixture-user")
      await Promise.resolve()
      lifecycle.uploadGate.resolve([
        {
          attachmentId: "attachment-1",
          contentType: "application/pdf",
          name: "notes.pdf",
          url: "https://fixtures.invalid/notes.pdf",
        },
      ])
      await sendPromise
    })
    await waitFor(() =>
      expect(
        api().messages.some((message) => message.id === "optimistic-user")
      ).toBe(true)
    )
    const assertStableDomIdentity = () => {
      expect(originalWrapper).toBe(originalTurn)
      if (qualifies) {
        expect(originalWrapper.previousElementSibling).toBe(originalSeparator)
      }
    }

    await waitFor(() => expect(api().status).toBe("submitted"))
    assertLifecycleFrame(api(), qualifies ? 1 : 0, originalWrapper)
    assertStableDomIdentity()
    const submittedUser = api().messages.find(
      (message) => message.id === "optimistic-user"
    )
    expect(submittedUser?.createdAt?.getTime()).toBe(now.getTime())
    expect(submittedUser?.parts).toContainEqual(
      expect.objectContaining({ url: "https://fixtures.invalid/notes.pdf" })
    )

    await waitFor(() => expect(lifecycle.getStreamWriter()).toBeTruthy())
    await act(async () => {
      const writer = lifecycle.getStreamWriter()
      if (!writer) throw new Error("UI stream writer unavailable")
      writer.write({ type: "start", messageId: "assistant-streaming" })
      writer.write({ type: "text-start", id: "assistant-text" })
      writer.write({
        type: "text-delta",
        delta: "Streaming answer",
        id: "assistant-text",
      })
      await Promise.resolve()
    })
    await waitFor(() => expect(api().status).toBe("streaming"))
    assertLifecycleFrame(api(), qualifies ? 1 : 0, originalWrapper)
    assertStableDomIdentity()
    expect(
      container?.querySelectorAll(
        '[data-turn-id-container="assistant-turn:optimistic-user"]'
      )
    ).toHaveLength(1)
    const streamingAssistant = container?.querySelector(
      '[data-turn-id="assistant-turn:optimistic-user"]'
    )
    expect(streamingAssistant).toBe(pendingAssistant)
    expect(streamingAssistant?.closest("[data-turn-id-container]")).toBe(
      pendingAssistantWrapper
    )

    await act(async () => {
      const writer = lifecycle.getStreamWriter()
      if (!writer) throw new Error("UI stream writer unavailable")
      writer.write({ type: "text-end", id: "assistant-text" })
      writer.write({ type: "finish", finishReason: "stop" })
      lifecycle.streamGate.resolve()
    })
    await waitFor(() => expect(api().status).toBe("ready"))

    act(() => {
      api().reconcile([
        {
          ...lifecycle.initialAssistant,
          metadata: { serverMessageId: "assistant-before-send" },
        },
        {
          id: "optimistic-user",
          role: "user",
          createdAt: new Date(now.getTime() + 1),
          metadata: { serverMessageId: "server-user" },
          parts: submittedUser?.parts ?? [],
        },
        {
          id: "assistant-streaming",
          role: "assistant",
          createdAt: new Date(now.getTime() + 2),
          metadata: { serverMessageId: "assistant-streaming" },
          parts: [{ type: "text", text: "Streaming answer" }],
          status: "completed",
        },
      ])
    })
    await waitFor(() =>
      expect(
        api().messages.find((message) => message.id === "optimistic-user")
          ?.metadata
      ).toMatchObject({ serverMessageId: "server-user" })
    )
    assertLifecycleFrame(api(), qualifies ? 1 : 0, originalWrapper)
    assertStableDomIdentity()
    expect(
      container?.querySelectorAll('[data-turn-id-container="optimistic-user"]')
    ).toHaveLength(1)
  }

  it("keeps one immediate separator and one keyed turn through every send phase", async () => {
    await runLifecycle(true)
  })

  it("keeps a fresh send separator-free through every send phase", async () => {
    await runLifecycle(false)
  })
})

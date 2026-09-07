/** @vitest-environment jsdom */

import { resetSharedChatStreamOwnersForTests } from "./use-detachable-chat-stream"
import { MAX_STOP_OBSERVED_TEXT_CHARS } from "@/convex/domain/message_facts"
import { CHAT_TURN_EXECUTION_BUDGET } from "@/lib/chat-turn/execution-budget"
import { takeChatPerfHeader } from "@/lib/observability/chat-performance-client"
import type { UIMessage } from "@ai-sdk/react"
import React, { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest"

beforeEach(() => {
  // The shared stream owner is process-lived; without a reset, one test's
  // live mock binding leaks into the next test's mount-time readopt.
  resetSharedChatStreamOwnersForTests()
  chatCoreMocks.historyLoading = false
  chatCoreMocks.chatAdmissionReady = true
  chatCoreMocks.useBindingMessages = false
})

let useChatCore: (typeof import("./use-chat-core"))["useChatCore"]

const chatCoreMocks = vi.hoisted(() => ({
  addToolApprovalResponse: vi.fn(),
  approveToolCall: vi.fn(),
  denyToolCall: vi.fn(),
  attachStagedFilesToChat: vi.fn(
    async (_convex: unknown, _chatId: string, attachmentIds: string[]) =>
      attachmentIds.map((attachmentId) => ({
        name: "project-notes.pdf",
        contentType: "application/pdf",
        url: `/api/files/${attachmentId}/preview`,
        attachmentId,
      }))
  ),
  bumpChat: vi.fn(),
  convexMutation: vi.fn(),
  regenerate: vi.fn(),
  sendMessage: vi.fn(),
  syncRun: vi.fn(),
  setMessages: vi.fn(),
  setWebSearchEnabled: vi.fn(),
  stop: vi.fn(),
  toast: vi.fn(),
  bindingStop: vi.fn(),
  updateTitle: vi.fn(),
  // Controllable useChat state for the selected-path projection effect tests.
  useChatState: { messages: [] as unknown[], status: "ready" as string },
  useBindingMessages: false,
  // Every constructed mock Chat instance in creation order, plus the instance
  // the hook currently renders through — the re-adoption tests assert which
  // binding survives a mounted A→B→A transition.
  chatInstances: [] as Array<{ status: string; messages: UIMessage[] }>,
  lastUseChatInstance: null as unknown,
  // Controllable Turn context hydration for the auto-submit gate tests.
  turnContextHydrated: true,
  historyLoading: false,
  chatAdmissionReady: true,
  // Controllable selected-run projection for the deferred-Stop tests.
  selectedRun: null as unknown,
}))

vi.mock("./turn-context", () => ({
  useTurnContext: () => ({
    selectedModel: "openai/gpt-4.1-mini",
    handleModelChange: vi.fn(),
    enableSearch: false,
    setEnableSearch: chatCoreMocks.setWebSearchEnabled,
    isAuthenticated: true,
    systemPrompt: "system prompt",
    isHydrated: chatCoreMocks.turnContextHydrated,
    getTurnSnapshot: () => ({
      selectedModel: "openai/gpt-4.1-mini",
      systemPrompt: "system prompt",
      enableSearch: false,
      isAuthenticated: true,
      isHydrated: chatCoreMocks.turnContextHydrated,
    }),
  }),
}))

vi.mock("@/convex/_generated/api", () => ({
  api: {
    chatRuntime: {
      approveToolCall: "approveToolCall",
      denyToolCall: "denyToolCall",
      stopGenerationRun: "stopGenerationRun",
    },
  },
}))

vi.mock("convex/react", () => ({
  useMutation: (mutation: string) => {
    if (mutation === "approveToolCall") return chatCoreMocks.approveToolCall
    if (mutation === "denyToolCall") return chatCoreMocks.denyToolCall
    return chatCoreMocks.convexMutation
  },
  useConvex: () => ({}),
  useConvexConnectionState: () => ({ isWebSocketConnected: true }),
}))

// The presentation resolver's durable input: guest/local default (no run),
// controllable for the deferred-Stop projection-gap tests.
vi.mock("@/lib/chat-store/messages/provider", () => ({
  useMessages: () => ({
    selectedRun: chatCoreMocks.selectedRun,
    isLoading: chatCoreMocks.historyLoading,
  }),
}))

vi.mock("@ai-sdk/react", () => ({
  // The hook constructs its own Chat instances (detachable stream bindings);
  // the mocked frame adapter below projects their state, while the watchdog
  // stops detached instances directly through a shared spy. `status` feeds
  // the owner's liveness check for detach-registration/re-adoption.
  Chat: class MockChat {
    status = "ready"
    readonly messages: UIMessage[]
    constructor(
      readonly options: {
        messages?: UIMessage[]
        transport: {
          sendMessages: (options: {
            messageId?: string
          }) => Promise<ReadableStream>
        }
      }
    ) {
      this.messages = options.messages ?? []
      chatCoreMocks.chatInstances.push(this)
    }
    sendMessage = (
      message: { messageId?: string },
      options?: { body?: Record<string, unknown> }
    ) => {
      chatCoreMocks.sendMessage(message, options)
      return this.options.transport
        .sendMessages({ messageId: message.messageId })
        .then(() => undefined)
    }
    stop = () => chatCoreMocks.bindingStop(this)
  },
}))

// Transport replay is covered with the real SDK in resumable-chat.test.ts.
vi.mock("@/lib/chat-stream/resumable-chat", async () => {
  const { Chat } = await import("@ai-sdk/react")
  return {
    ResumableChat: class extends Chat<UIMessage> {
      syncRun = chatCoreMocks.syncRun
      detachObserver = vi.fn()
    },
  }
})

vi.mock("./use-frame-aligned-chat", () => ({
  useFrameAlignedChat: ({
    chat,
  }: {
    chat: { sendMessage: typeof chatCoreMocks.sendMessage; messages: UIMessage[] }
  }) => {
    chatCoreMocks.lastUseChatInstance = chat
    return {
      messages: chatCoreMocks.useBindingMessages
        ? chat.messages
        : chatCoreMocks.useChatState.messages,
      sendMessage: chat.sendMessage,
      regenerate: chatCoreMocks.regenerate,
      status: chatCoreMocks.useChatState.status,
      error: undefined,
      stop: chatCoreMocks.stop,
      setMessages: chatCoreMocks.setMessages,
      addToolApprovalResponse: chatCoreMocks.addToolApprovalResponse,
    }
  },
}))

vi.mock("ai", () => ({
  DefaultChatTransport: class MockDefaultChatTransport {
    async sendMessages() {
      return new ReadableStream()
    }
  },
  lastAssistantMessageIsCompleteWithApprovalResponses: vi.fn(() => false),
}))

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(window.location.search),
}))

vi.mock("@/components/ui/toast", () => ({
  toast: chatCoreMocks.toast,
}))

vi.mock("@/lib/api", () => ({
  getOrCreateGuestUserId: vi.fn(async (user: { id?: string } | null) =>
    user?.id ? user.id : "guest_1"
  ),
}))

vi.mock("@/lib/file-handling", () => ({
  attachStagedFilesToChat: chatCoreMocks.attachStagedFilesToChat,
}))

vi.mock("@/lib/chat-store/chats/provider", () => ({
  useChats: () => ({
    updateTitle: chatCoreMocks.updateTitle,
  }),
}))

const authenticatedUser = {
  id: "user-1",
  email: "user@example.com",
  display_name: "User",
  profile_image: null,
  anonymous: false,
  premium: true,
  message_count: 0,
  daily_message_count: 0,
  daily_reset: null,
  last_active_at: null,
  created_at: null,
  favorite_models: null,
  system_prompt: "system prompt",
}

async function flushAsyncWork() {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

describe("useChatCore prompt query handling", () => {
  let container: HTMLDivElement | null = null
  let root: Root | null = null

  beforeAll(() => {
    ;(
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true
    ;(
      globalThis as { requestAnimationFrame?: typeof requestAnimationFrame }
    ).requestAnimationFrame = (callback: FrameRequestCallback) =>
      window.setTimeout(() => callback(performance.now()), 0)
    const objectStoreNames = Object.assign(["chats", "messages", "sync"], {
      contains: (name: string) => ["chats", "messages", "sync"].includes(name),
    })
    const db = {
      version: 2,
      objectStoreNames,
      close: vi.fn(),
      createObjectStore: vi.fn(),
    }
    ;(globalThis as { indexedDB?: IDBFactory }).indexedDB = {
      open: vi.fn(() => {
        const request = {
          result: db,
          error: null,
        } as unknown as IDBOpenDBRequest
        window.setTimeout(() => request.onsuccess?.(new Event("success")), 0)
        return request
      }),
      deleteDatabase: vi.fn(() => {
        const request = { result: undefined } as unknown as IDBOpenDBRequest
        window.setTimeout(() => request.onsuccess?.(new Event("success")), 0)
        return request
      }),
    } as unknown as IDBFactory
  })

  beforeAll(async () => {
    ;({ useChatCore } = await import("./use-chat-core"))
  })

  beforeEach(() => {
    vi.clearAllMocks()
    chatCoreMocks.turnContextHydrated = true
    chatCoreMocks.useChatState.messages = []
  })

  afterEach(() => {
    const mountedRoot = root
    if (mountedRoot) {
      act(() => {
        mountedRoot.unmount()
      })
    }
    container?.remove()
    container = null
    root = null
  })

  function renderCore({
    search,
    chatId = "chat-project",
    initialMessages = [],
    ensureChatExists = vi.fn(async () => ({ chatId: "chat-project" })),
    checkLimitsAndNotify = vi.fn(async () => true),
  }: {
    search: string
    chatId?: string | null
    initialMessages?: UIMessage[]
    ensureChatExists?: Parameters<typeof useChatCore>[0]["ensureChatExists"]
    checkLimitsAndNotify?: (uid: string) => Promise<boolean>
  }) {
    window.history.replaceState(
      null,
      "",
      `${chatId ? `/c/${chatId}` : "/"}${search}`
    )

    container = document.createElement("div")
    document.body.appendChild(container)
    root = createRoot(container)
    const currentCoreRef: {
      current: ReturnType<typeof useChatCore> | undefined
    } = { current: undefined }

    function Harness() {
      const core = useChatCore({
        initialMessages,
        cacheAndAddMessage: vi.fn(),
        chatId,
        user: authenticatedUser,
        isChatAdmissionReady: chatCoreMocks.chatAdmissionReady,
        checkLimitsAndNotify,
        ensureChatExists,
        firstTurn: { begin: () => "chat-1", rollback: () => {} },
        bumpChat: chatCoreMocks.bumpChat,
      })
      React.useEffect(() => {
        currentCoreRef.current = core
      }, [core])
      return null
    }

    const rerender = (next?: {
      chatId: string
      initialMessages: UIMessage[]
      search: string
      ensureChatExists?: Parameters<typeof useChatCore>[0]["ensureChatExists"]
    }) => {
      if (next) {
        chatId = next.chatId
        initialMessages = next.initialMessages
        if (next.ensureChatExists) ensureChatExists = next.ensureChatExists
        window.history.replaceState(null, "", `/c/${chatId}${next.search}`)
      }
      act(() => {
        root?.render(
          <React.StrictMode>
            <Harness />
          </React.StrictMode>
        )
      })
    }
    rerender()

    return {
      checkLimitsAndNotify,
      ensureChatExists,
      rerender,
      getCore: () => currentCoreRef.current,
    }
  }

  it("keeps prompt-only links as composer hydration without dispatching", async () => {
    renderCore({ search: "?prompt=Project%20question" })
    await flushAsyncWork()

    expect(chatCoreMocks.sendMessage).not.toHaveBeenCalled()
    expect(window.location.search).toBe("?prompt=Project%20question")
  })

  it("auto-submits a transferred project prompt once through the chat turn", async () => {
    const ensureChatExists = vi.fn(async () => ({ chatId: "chat-project" }))

    renderCore({
      search: "?prompt=Project%20question&autoSubmit=1",
      ensureChatExists,
    })
    await flushAsyncWork()

    expect(ensureChatExists).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-1",
        text: "Project question",
        clientMessageId: expect.any(String),
        attachmentIds: [],
      })
    )
    expect(chatCoreMocks.sendMessage).toHaveBeenCalledTimes(1)
    expect(chatCoreMocks.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        id: expect.any(String),
        role: "user",
        parts: [{ type: "text", text: "Project question" }],
        createdAt: expect.any(Date),
        messageId: expect.any(String),
      }),
      {
        body: expect.objectContaining({
          chatId: "chat-project",
          userId: "user-1",
          model: "openai/gpt-4.1-mini",
          systemPrompt: "system prompt",
          enableSearch: false,
          chatVersion: 1,
          expectedVisibleMessageCount: 0,
        }),
      }
    )
    const dispatchedMessage = chatCoreMocks.sendMessage.mock.calls[0]?.[0]
    expect(dispatchedMessage.messageId).toBe(dispatchedMessage.id)
    expect(window.location.pathname).toBe("/c/chat-project")
    expect(window.location.search).toBe("")
  })

  it.each(["context", "history", "account"])("defers auto-submit until %s hydrates, then dispatches once", async (source) => {
    // Defer before consuming the once-guard, preserving the pending prompt.
    chatCoreMocks.turnContextHydrated = source !== "context"
    chatCoreMocks.historyLoading = source === "history"
    chatCoreMocks.chatAdmissionReady = source !== "account"

    const { rerender } = renderCore({
      search: "?prompt=Project%20question&autoSubmit=1",
    })
    await flushAsyncWork()

    expect(chatCoreMocks.sendMessage).not.toHaveBeenCalled()
    // The URL cleanup must also wait — the prompt params survive the deferral.
    expect(window.location.search).toBe(
      "?prompt=Project%20question&autoSubmit=1"
    )

    chatCoreMocks.turnContextHydrated = true
    chatCoreMocks.historyLoading = false
    chatCoreMocks.chatAdmissionReady = true
    rerender()
    await flushAsyncWork()

    expect(chatCoreMocks.sendMessage).toHaveBeenCalledTimes(1)
    expect(window.location.search).toBe("")
  })

  it("holds existing-chat sends until loaded history reaches the rendered path", async () => {
    const history: UIMessage[] = [
      { id: "user-seed", role: "user", parts: [{ type: "text", text: "seed" }] },
      { id: "assistant-seed", role: "assistant", parts: [{ type: "text", text: "answer" }], metadata: { serverMessageId: "assistant-server" } },
    ]
    chatCoreMocks.historyLoading = true
    const { getCore, rerender } = renderCore({ search: "", initialMessages: history })
    const payload = { text: "follow-up", files: [], attachments: [] }
    await act(async () => {
      expect(getCore()!.isSendReady).toBe(false)
      await expect(getCore()!.submit(payload)).resolves.toBe(false)
    })
    chatCoreMocks.historyLoading = false
    chatCoreMocks.chatAdmissionReady = true
    rerender()
    expect(getCore()!.isSendReady).toBe(false)
    expect(chatCoreMocks.sendMessage).not.toHaveBeenCalled()

    chatCoreMocks.useChatState.messages = history
    rerender()
    expect(getCore()!.isSendReady).toBe(true)
    await act(async () => { await getCore()!.submit(payload) })
    expect(chatCoreMocks.sendMessage).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ body: expect.objectContaining({
        expectedVisibleMessageCount: 2,
        tailMessageId: "assistant-server",
      }) })
    )
  })

  it("retains submit identity while using the latest committed history and chat controller", async () => {
    const history: UIMessage[] = [
      { id: "user-b", role: "user", parts: [{ type: "text", text: "question" }] },
      { id: "assistant-b", role: "assistant", parts: [{ type: "text", text: "answer" }], metadata: { serverMessageId: "assistant-server-b" } },
    ]
    const { getCore, rerender } = renderCore({
      search: "",
      chatId: "chat-a",
      ensureChatExists: vi.fn(async () => ({ chatId: "chat-a" })),
    })
    const retainedSubmit = getCore()!.submit

    chatCoreMocks.useChatState.messages = history
    rerender()
    expect(getCore()!.submit).toBe(retainedSubmit)
    rerender({
      chatId: "chat-b",
      initialMessages: history,
      search: "",
      ensureChatExists: vi.fn(async () => ({ chatId: "chat-b" })),
    })
    expect(getCore()!.submit).toBe(retainedSubmit)

    await act(async () => {
      await expect(retainedSubmit({ text: "follow-up", files: [], attachments: [] })).resolves.toBe(true)
    })
    expect(chatCoreMocks.sendMessage).toHaveBeenCalledOnce()
    expect(chatCoreMocks.sendMessage).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ body: expect.objectContaining({
        chatId: "chat-b",
        chatVersion: 3,
        expectedVisibleMessageCount: 2,
        tailMessageId: "assistant-server-b",
      }) })
    )
    expect(chatCoreMocks.bumpChat).toHaveBeenCalledWith("chat-b")
  })

  it("auto-submits on a cached chat switch only after its stream binding commits", async () => {
    chatCoreMocks.useBindingMessages = true
    const history = (id: string): UIMessage[] => [
      { id, role: "assistant", parts: [{ type: "text", text: id }], metadata: { serverMessageId: id } },
    ]
    const { rerender } = renderCore({
      search: "",
      chatId: "chat-a",
      initialMessages: history("assistant-a"),
      ensureChatExists: vi.fn(async () => ({ chatId: "chat-b" })),
    })
    rerender({
      chatId: "chat-b",
      initialMessages: history("assistant-b"),
      search: "?prompt=Follow%20up&autoSubmit=1",
    })
    await flushAsyncWork()
    expect(chatCoreMocks.sendMessage).toHaveBeenCalledOnce()
    expect(chatCoreMocks.sendMessage).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ body: expect.objectContaining({
        chatId: "chat-b",
        expectedVisibleMessageCount: 1,
        tailMessageId: "assistant-b",
      }) })
    )
  })

  it("holds a first send until account admission is ready without dispatching or consuming the draft", async () => {
    chatCoreMocks.chatAdmissionReady = false
    const { getCore, rerender } = renderCore({ search: "", chatId: null })
    const payload = { text: "first prompt", files: [], attachments: [] }
    expect(getCore()!.isSendReady).toBe(false)
    await act(async () => { await expect(getCore()!.submit(payload)).resolves.toBe(false) })
    expect(chatCoreMocks.sendMessage).not.toHaveBeenCalled()
    chatCoreMocks.chatAdmissionReady = true
    rerender()
    expect(getCore()!.isSendReady).toBe(true)
    await act(async () => { await getCore()!.submit(payload) })
    expect(chatCoreMocks.sendMessage).toHaveBeenCalledOnce()
  })

  it("allows a first send without waiting for existing-history readiness", async () => {
    chatCoreMocks.historyLoading = true
    const { getCore } = renderCore({ search: "", chatId: null })
    expect(getCore()!.isSendReady).toBe(true)
    await act(async () => {
      await getCore()!.submit({ text: "first prompt", files: [], attachments: [] })
    })
    expect(chatCoreMocks.sendMessage).toHaveBeenCalledOnce()
  })

  it("disarms the performance header when submit is rejected before dispatch", async () => {
    process.env.NEXT_PUBLIC_CHAT_PERF_INSTRUMENTATION = "true"
    try {
      const { getCore } = renderCore({
        search: "",
        checkLimitsAndNotify: vi.fn(async () => false),
      })
      await act(async () => {
        await expect(
          getCore()?.submit({
            text: "Project question",
            files: [],
            attachments: [],
          })
        ).resolves.toBe(false)
      })

      expect(chatCoreMocks.sendMessage).not.toHaveBeenCalled()
      expect(takeChatPerfHeader()).toEqual({})
    } finally {
      delete process.env.NEXT_PUBLIC_CHAT_PERF_INSTRUMENTATION
    }
  })

  it("does not discover a retained stream while first-turn creation is submitting", async () => {
    let finishCreation!: (value: { chatId: string }) => void
    const ensureChatExists = vi.fn(() => new Promise<{ chatId: string }>((resolve) => { finishCreation = resolve }))
    const { getCore, rerender } = renderCore({ search: "", chatId: null, ensureChatExists })
      let submitted!: Promise<boolean>
      await act(async () => {
        submitted = getCore()!.submit({ text: "First turn", files: [], attachments: [] })
        await vi.waitFor(() => expect(ensureChatExists).toHaveBeenCalledTimes(1))
      })
      chatCoreMocks.historyLoading = true
      rerender({ chatId: "chat-first", initialMessages: [], search: "" })
      expect(getCore()!.isSubmitting).toBe(true)
      expect(chatCoreMocks.syncRun.mock.calls.at(-1)?.[2]).toMatchObject({ chatId: "chat-first", isLoading: true, isSubmitting: true })
      await act(async () => {
        finishCreation({ chatId: "chat-first" })
        await submitted
      })
  })

  it("carries Stop across first-turn chat creation and prevents generation dispatch", async () => {
    const confirmDispatched = vi.fn()
    let resolveChat!: (
      chat: Awaited<
        ReturnType<Parameters<typeof useChatCore>[0]["ensureChatExists"]>
      >
    ) => void
    const ensureChatExists = vi.fn(
      () =>
        new Promise<
          Awaited<
            ReturnType<Parameters<typeof useChatCore>[0]["ensureChatExists"]>
          >
        >((resolve) => {
          resolveChat = resolve
        })
    )
    const { getCore } = renderCore({
      search: "",
      chatId: null,
      ensureChatExists,
    })

    let submitted!: Promise<boolean>
    await act(async () => {
      submitted = getCore()!.submit({
        text: "Stop this first turn",
        files: [],
        attachments: [],
      })
      await vi.waitFor(() =>
        expect(ensureChatExists).toHaveBeenCalledTimes(1)
      )
      await getCore()!.stop()
      resolveChat({
        chatId: "chat-first",
        firstTurn: {
          userMessageId: "message_user_1",
          clientMessageId: "stopped-before-dispatch",
          attachments: [],
        },
        confirmDispatched,
      })
      await expect(submitted).resolves.toBe(true)
    })

    expect(chatCoreMocks.stop).toHaveBeenCalledTimes(1)
    expect(chatCoreMocks.sendMessage).not.toHaveBeenCalled()
    expect(confirmDispatched).toHaveBeenCalledTimes(1)
  })
})

describe("useChatCore selected-path projection", () => {
  let container: HTMLDivElement | null = null
  let root: Root | null = null

  beforeEach(() => {
    vi.clearAllMocks()
    chatCoreMocks.useChatState.messages = []
    chatCoreMocks.useChatState.status = "ready"
    chatCoreMocks.chatInstances.length = 0
    chatCoreMocks.lastUseChatInstance = null
  })

  afterEach(() => {
    const mountedRoot = root
    if (mountedRoot) act(() => mountedRoot.unmount())
    container?.remove()
    container = null
    root = null
  })

  function Harness({
    initialMessages,
    chatId = "chat_projection",
  }: {
    initialMessages: UIMessage[]
    chatId?: string | null
  }) {
    useChatCore({
      initialMessages,
      cacheAndAddMessage: vi.fn(),
      chatId,
      user: authenticatedUser,
      isChatAdmissionReady: chatCoreMocks.chatAdmissionReady,
      checkLimitsAndNotify: vi.fn(async () => true),
      ensureChatExists: vi.fn(async () => ({ chatId: "chat_projection" })),
      firstTurn: { begin: () => "chat-1", rollback: () => {} },
      bumpChat: chatCoreMocks.bumpChat,
    })
    return null
  }

  function render(initialMessages: UIMessage[], chatId?: string | null) {
    act(() => {
      root?.render(
        <Harness initialMessages={initialMessages} chatId={chatId} />
      )
    })
  }

  const serverPath = [
    {
      id: "s1",
      role: "user" as const,
      parts: [{ type: "text" as const, text: "hi" }],
      metadata: { serverMessageId: "s1" },
    },
  ] as unknown as UIMessage[]

  function mount() {
    window.history.replaceState(null, "", "/c/chat_projection")
    container = document.createElement("div")
    document.body.appendChild(container)
    root = createRoot(container)
  }

  it("projects the reactive server selected path into useChat when idle", () => {
    mount()
    render([]) // hydrates the empty chat
    chatCoreMocks.setMessages.mockClear()

    render(serverPath) // a reactive server update while idle

    expect(chatCoreMocks.setMessages).toHaveBeenCalledWith(serverPath)
  })

  it("does not project while a generation is streaming", () => {
    mount()
    render([])
    chatCoreMocks.useChatState.status = "streaming"
    chatCoreMocks.setMessages.mockClear()

    render(serverPath) // server update arrives mid-stream

    expect(chatCoreMocks.setMessages).not.toHaveBeenCalled()
  })

  it("preserves the optimistic user row when a fresh chat route hydrates before persistence", () => {
    mount()
    render([], null)

    const optimisticMessages = [
      {
        id: "optimistic-user",
        role: "user" as const,
        parts: [{ type: "text" as const, text: "hello" }],
      },
    ] as unknown as UIMessage[]
    chatCoreMocks.useChatState.messages = optimisticMessages
    chatCoreMocks.useChatState.status = "streaming"
    chatCoreMocks.setMessages.mockClear()

    render([], "chat_projection")

    expect(chatCoreMocks.setMessages).toHaveBeenCalledTimes(1)
    const update = chatCoreMocks.setMessages.mock.calls[0]?.[0]
    expect(update).toBeTypeOf("function")
    expect(
      (update as (messages: UIMessage[]) => UIMessage[])(optimisticMessages)
    ).toBe(optimisticMessages)
  })

  it("preserves a live assistant when first hydration contains only the persisted user row", () => {
    mount()
    render([], null)

    const liveMessages = [
      {
        id: "optimistic-user",
        role: "user" as const,
        parts: [{ type: "text" as const, text: "hello" }],
      },
      {
        id: "assistant-streaming",
        role: "assistant" as const,
        parts: [{ type: "text" as const, text: "Hi" }],
      },
    ] as unknown as UIMessage[]
    const userOnlyServerPath = [
      {
        ...liveMessages[0],
        metadata: { serverMessageId: "server-user" },
      },
    ] as unknown as UIMessage[]
    chatCoreMocks.useChatState.messages = liveMessages
    chatCoreMocks.useChatState.status = "streaming"
    chatCoreMocks.setMessages.mockClear()

    render(userOnlyServerPath, "chat_projection")

    expect(chatCoreMocks.setMessages).toHaveBeenCalledTimes(1)
    const update = chatCoreMocks.setMessages.mock.calls[0]?.[0]
    expect(update).toBeTypeOf("function")
    const projected = (update as (messages: UIMessage[]) => UIMessage[])(
      liveMessages
    )
    expect(projected.map((message) => message.id)).toEqual([
      "optimistic-user",
      "assistant-streaming",
    ])
  })

  it("stops a detached binding's stream when the watchdog budget elapses", () => {
    vi.useFakeTimers()
    try {
      mount()
      render([], "chat_projection")
      chatCoreMocks.chatInstances[0].status = "streaming"
      render([], null) // mounted Back to onboarding → detach

      expect(chatCoreMocks.bindingStop).not.toHaveBeenCalled()
      act(() => {
        vi.advanceTimersByTime(
          CHAT_TURN_EXECUTION_BUDGET.clientStreamWatchdogMs
        )
      })
      expect(chatCoreMocks.bindingStop).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it("defers a divergent branch swap to settle when entering a chat mid-stream", () => {
    mount()
    render([], "chat_a")

    // A re-adopted binding's array: anchored messages the SDK is actively
    // streaming into. The entry projection must not wholesale-swap it even
    // when the server path diverged (e.g. a sibling branch selected in
    // another tab) — settle-time projection owns divergence.
    const liveMessages = [
      {
        id: "u-live",
        role: "user" as const,
        parts: [{ type: "text" as const, text: "hi" }],
        metadata: { serverMessageId: "u-live" },
      },
      {
        id: "a-live",
        role: "assistant" as const,
        parts: [{ type: "text" as const, text: "streaming…" }],
        metadata: { serverMessageId: "a-live" },
      },
    ] as unknown as UIMessage[]
    const divergentPath = [
      {
        id: "s-other",
        role: "user" as const,
        parts: [{ type: "text" as const, text: "other branch" }],
        metadata: { serverMessageId: "s-other" },
      },
    ] as unknown as UIMessage[]
    chatCoreMocks.useChatState.messages = liveMessages
    chatCoreMocks.useChatState.status = "streaming"
    chatCoreMocks.setMessages.mockClear()

    render(divergentPath, "chat_b") // mid-stream entry (re-adopted binding)

    const update = chatCoreMocks.setMessages.mock.calls[0]?.[0]
    expect(update).toBeTypeOf("function")
    expect(
      (update as (messages: UIMessage[]) => UIMessage[])(liveMessages)
    ).toBe(liveMessages)
  })
})

describe("useChatCore stream re-adoption on return", () => {
  let container: HTMLDivElement | null = null
  let root: Root | null = null

  beforeEach(() => {
    vi.clearAllMocks()
    chatCoreMocks.useChatState.messages = []
    chatCoreMocks.useChatState.status = "ready"
    chatCoreMocks.chatInstances.length = 0
    chatCoreMocks.lastUseChatInstance = null
  })

  afterEach(() => {
    const mountedRoot = root
    if (mountedRoot) act(() => mountedRoot.unmount())
    container?.remove()
    container = null
    root = null
  })

  function Harness({
    initialMessages,
    chatId,
  }: {
    initialMessages: UIMessage[]
    chatId: string | null
  }) {
    useChatCore({
      initialMessages,
      cacheAndAddMessage: vi.fn(),
      chatId,
      user: authenticatedUser,
      isChatAdmissionReady: chatCoreMocks.chatAdmissionReady,
      checkLimitsAndNotify: vi.fn(async () => true),
      ensureChatExists: vi.fn(async () => ({ chatId: "chat_a" })),
      firstTurn: { begin: () => "chat-1", rollback: () => {} },
      bumpChat: chatCoreMocks.bumpChat,
    })
    return null
  }

  function render(chatId: string | null, initialMessages: UIMessage[] = []) {
    act(() => {
      root?.render(
        <Harness initialMessages={initialMessages} chatId={chatId} />
      )
    })
  }

  function mount() {
    window.history.replaceState(null, "", "/c/chat_a")
    container = document.createElement("div")
    document.body.appendChild(container)
    root = createRoot(container)
  }

  it("re-adopts a still-streaming detached binding on return, clears its watchdog, and re-arms on the next detach", () => {
    vi.useFakeTimers()
    try {
      mount()
      render("chat_a")
      const instances = chatCoreMocks.chatInstances
      expect(instances).toHaveLength(1)
      instances[0].status = "streaming" // a live generation in chat_a

      render("chat_b") // away mid-stream → detach + register origin
      expect(instances).toHaveLength(2)

      render("chat_a") // return → re-adopt, no fresh binding
      expect(instances).toHaveLength(2)
      expect(chatCoreMocks.lastUseChatInstance).toBe(instances[0])

      // Re-adoption cleared the origin watchdog: after the full budget only
      // chat_b's idle detached binding is stopped, never the live stream.
      act(() => {
        vi.advanceTimersByTime(
          CHAT_TURN_EXECUTION_BUDGET.clientStreamWatchdogMs
        )
      })
      expect(chatCoreMocks.bindingStop).not.toHaveBeenCalledWith(instances[0])

      // Navigating away again re-detaches the still-live stream: the
      // watchdog re-arms with a fresh budget.
      render("chat_b")
      act(() => {
        vi.advanceTimersByTime(
          CHAT_TURN_EXECUTION_BUDGET.clientStreamWatchdogMs
        )
      })
      expect(chatCoreMocks.bindingStop).toHaveBeenCalledWith(instances[0])
    } finally {
      vi.useRealTimers()
    }
  })

  it("creates a fresh binding when the origin stream ended while away", () => {
    mount()
    render("chat_a")
    const instances = chatCoreMocks.chatInstances
    instances[0].status = "streaming"

    render("chat_b") // away mid-stream → registered as re-adoptable
    instances[0].status = "ready" // …but the stream ends while away

    render("chat_a") // return → liveness re-check refuses the dead binding
    expect(instances).toHaveLength(3)
    expect(chatCoreMocks.lastUseChatInstance).toBe(instances[2])
  })

  it("falls back to a fresh binding when the selected path changed while away", () => {
    vi.useFakeTimers()
    try {
      const originPath = [
        {
          id: "user-origin",
          role: "user",
          parts: [{ type: "text", text: "origin" }],
          metadata: { serverMessageId: "user-origin" },
        },
      ] as UIMessage[]
      const otherPath = [
        {
          id: "user-other",
          role: "user",
          parts: [{ type: "text", text: "other branch" }],
          metadata: { serverMessageId: "user-other" },
        },
      ] as UIMessage[]

      mount()
      render("chat_a", originPath)
      const instances = chatCoreMocks.chatInstances
      instances[0].status = "streaming"

      render("chat_b") // detach and register chat_a's live binding
      expect(instances).toHaveLength(2)

      render("chat_a", otherPath) // another tab selected a sibling while away
      expect(instances).toHaveLength(3)
      expect(chatCoreMocks.lastUseChatInstance).toBe(instances[2])

      // The rejected obsolete binding remains detached and bounded by its
      // existing watchdog; it is never promoted back to the visible surface.
      act(() => {
        vi.advanceTimersByTime(
          CHAT_TURN_EXECUTION_BUDGET.clientStreamWatchdogMs
        )
      })
      expect(chatCoreMocks.bindingStop).toHaveBeenCalledWith(instances[0])
    } finally {
      vi.useRealTimers()
    }
  })

  it("re-adopts through the onboarding surface (Back mid-stream, then Forward)", () => {
    mount()
    render("chat_a")
    const instances = chatCoreMocks.chatInstances
    instances[0].status = "streaming"

    render(null) // Back → detach + register; fresh unowned onboarding binding
    expect(instances).toHaveLength(2)

    // Forward re-enters chat_a through the null → chatId branch: the idle
    // onboarding binding is discarded and the live origin stream re-adopted,
    // NOT first-turn-adopted into an empty fresh binding.
    render("chat_a")
    expect(instances).toHaveLength(2)
    expect(chatCoreMocks.lastUseChatInstance).toBe(instances[0])
  })

  it("creates a fresh selected-path binding after a divergent onboarding return", () => {
    vi.useFakeTimers()
    try {
      const originPath = [
        {
          id: "user-origin",
          role: "user",
          parts: [{ type: "text", text: "origin" }],
          metadata: { serverMessageId: "user-origin" },
        },
      ] as UIMessage[]
      const otherPath = [
        {
          id: "user-other",
          role: "user",
          parts: [{ type: "text", text: "other branch" }],
          metadata: { serverMessageId: "user-other" },
        },
      ] as UIMessage[]

      mount()
      render("chat_a", originPath)
      const instances = chatCoreMocks.chatInstances
      instances[0].status = "streaming"

      render(null) // Back → detach origin and create an idle onboarding binding
      expect(instances).toHaveLength(2)

      // Another tab selects a sibling before Forward re-enters chat_a. The
      // divergent detached binding is rejected, and the idle onboarding binding
      // must not be adopted as though no detached binding had existed.
      render("chat_a", otherPath)
      expect(instances).toHaveLength(3)
      expect(chatCoreMocks.lastUseChatInstance).toBe(instances[2])
      expect(instances[2].messages).toEqual(otherPath)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe("useChatCore deferred durable Stop (projection gap)", () => {
  let container: HTMLDivElement | null = null
  let root: Root | null = null
  const coreRef: { current: ReturnType<typeof useChatCore> | null } = {
    current: null,
  }

  beforeEach(() => {
    vi.clearAllMocks()
    chatCoreMocks.useChatState.messages = []
    chatCoreMocks.useChatState.status = "ready"
    chatCoreMocks.selectedRun = null
  })

  afterEach(() => {
    const mountedRoot = root
    if (mountedRoot) act(() => mountedRoot.unmount())
    container?.remove()
    container = null
    root = null
    coreRef.current = null
  })

  function Harness() {
    const core = useChatCore({
      initialMessages: [] as UIMessage[],
      cacheAndAddMessage: vi.fn(),
      chatId: "chat_stopgap",
      user: authenticatedUser,
      isChatAdmissionReady: chatCoreMocks.chatAdmissionReady,
      checkLimitsAndNotify: vi.fn(async () => true),
      ensureChatExists: vi.fn(async () => ({ chatId: "chat_stopgap" })),
      firstTurn: { begin: () => "chat-1", rollback: () => {} },
      bumpChat: chatCoreMocks.bumpChat,
    })
    React.useEffect(() => {
      coreRef.current = core
    })
    return null
  }

  function render() {
    act(() => {
      root?.render(<Harness />)
    })
  }

  function mount() {
    window.history.replaceState(null, "", "/c/chat_stopgap")
    container = document.createElement("div")
    document.body.appendChild(container)
    root = createRoot(container)
    render()
  }

  it("defers a Stop clicked before the run projection arrives, then fires at the exact run id", async () => {
    mount()
    // Stop lands before either response acceptance or the run projection. The
    // local transport must stay attached until one of those proves the durable
    // handoff; the intent then fires once the projection delivers the run.
    await act(async () => {
      await coreRef.current?.stop()
    })
    expect(chatCoreMocks.stop).not.toHaveBeenCalled()
    expect(chatCoreMocks.convexMutation).not.toHaveBeenCalled()

    chatCoreMocks.selectedRun = {
      runId: "run_live",
      assistantMessageId: "msg_live",
      status: "streaming",
      pendingApproval: null,
    }
    render()
    await flushAsyncWork()

    expect(chatCoreMocks.convexMutation).toHaveBeenCalledTimes(1)
    expect(chatCoreMocks.convexMutation).toHaveBeenCalledWith({
      runId: "run_live",
    })
    expect(chatCoreMocks.stop).toHaveBeenCalledTimes(1)
  })

  it("cuts an accepted local stream while deferring the exact durable run stop", async () => {
    chatCoreMocks.useChatState.status = "streaming"
    mount()

    await act(async () => {
      await coreRef.current?.stop()
    })

    expect(chatCoreMocks.stop).toHaveBeenCalledTimes(1)
    expect(chatCoreMocks.convexMutation).not.toHaveBeenCalled()

    chatCoreMocks.selectedRun = {
      runId: "run_accepted",
      assistantMessageId: "msg_accepted",
      status: "streaming",
      pendingApproval: null,
    }
    render()
    await flushAsyncWork()

    expect(chatCoreMocks.convexMutation).toHaveBeenCalledTimes(1)
    expect(chatCoreMocks.convexMutation).toHaveBeenCalledWith({
      runId: "run_accepted",
    })
    expect(chatCoreMocks.stop).toHaveBeenCalledTimes(1)
  })

  it("captures the newest SDK text before freezing locally without waiting for durable Stop", async () => {
    chatCoreMocks.useChatState.status = "streaming"
    chatCoreMocks.useChatState.messages = [
      { id: "msg_live", role: "assistant", parts: [{ type: "text", text: "1." }] },
    ]
    chatCoreMocks.selectedRun = {
      runId: "run_live",
      assistantMessageId: "msg_live",
      status: "streaming",
      pendingApproval: null,
    }
    mount()
    const binding = chatCoreMocks.chatInstances.at(-1)
    if (!binding) throw new Error("Missing SDK binding")
    binding.messages.push({
      id: "msg_live",
      role: "assistant",
      parts: [{ type: "text", text: "1. The already visible response." }],
    })
    let resolveStop: (() => void) | undefined
    chatCoreMocks.convexMutation.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        resolveStop = resolve
      })
    )
    chatCoreMocks.stop.mockImplementationOnce(() => {
      binding.messages.length = 0
    })

    let pendingStop: Promise<void> | undefined
    act(() => {
      pendingStop = coreRef.current?.stop()
    })

    expect(chatCoreMocks.convexMutation).toHaveBeenCalledWith({
      runId: "run_live",
      observedText: "1. The already visible response.",
    })
    expect(chatCoreMocks.stop).toHaveBeenCalled()
    await act(async () => {
      resolveStop?.()
      await pendingStop
    })
  })

  it("still stops when SDK text exceeds the optional prefix payload limit", async () => {
    chatCoreMocks.useChatState.status = "streaming"
    chatCoreMocks.selectedRun = {
      runId: "run_live",
      assistantMessageId: "msg_live",
      status: "streaming",
      pendingApproval: null,
    }
    mount()
    const binding = chatCoreMocks.chatInstances.at(-1)
    if (!binding) throw new Error("Missing SDK binding")
    binding.messages.push({
      id: "msg_live",
      role: "assistant",
      parts: [{ type: "text", text: "x".repeat(MAX_STOP_OBSERVED_TEXT_CHARS + 1) }],
    })

    await act(async () => {
      await coreRef.current?.stop()
    })

    expect(chatCoreMocks.convexMutation).toHaveBeenCalledExactlyOnceWith({
      runId: "run_live",
    })
    expect(chatCoreMocks.stop).toHaveBeenCalled()
  })

  it("disarms without firing when the arriving projection is already terminal", async () => {
    mount()
    await act(async () => {
      await coreRef.current?.stop()
    })

    chatCoreMocks.selectedRun = {
      runId: "run_done",
      assistantMessageId: "msg_done",
      status: "completed",
      pendingApproval: null,
    }
    render()
    await flushAsyncWork()

    expect(chatCoreMocks.convexMutation).not.toHaveBeenCalled()
  })

  it("expires a deferred Stop intent without leaving a timer-driven action relay", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
    try {
      mount()
      await act(async () => {
        await coreRef.current?.stop()
      })

      act(() => {
        vi.advanceTimersByTime(30_000)
      })
      chatCoreMocks.selectedRun = {
        runId: "run_too_late",
        assistantMessageId: "msg_late",
        status: "streaming",
        pendingApproval: null,
      }
      render()
      await act(async () => {
        await Promise.resolve()
      })

      expect(chatCoreMocks.convexMutation).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it("waits through the PREVIOUS turn's terminal run instead of disarming on it (chat with history)", async () => {
    // A prior terminal run may still be selected while a new run is pending.
    // The intent must wait for a new run id.
    const previousTerminalRun = {
      runId: "run_previous",
      assistantMessageId: "msg_previous",
      status: "completed",
      pendingApproval: null,
    }
    chatCoreMocks.selectedRun = previousTerminalRun
    mount()
    await act(async () => {
      await coreRef.current?.stop()
    })
    expect(chatCoreMocks.convexMutation).not.toHaveBeenCalled()

    // The previous run's projection is unchanged: still armed, still quiet.
    render()
    await flushAsyncWork()
    expect(chatCoreMocks.convexMutation).not.toHaveBeenCalled()

    // The stopped dispatch's own run arrives — the intent fires at ITS id.
    chatCoreMocks.selectedRun = {
      runId: "run_new_dispatch",
      assistantMessageId: "msg_new",
      status: "streaming",
      pendingApproval: null,
    }
    render()
    await flushAsyncWork()

    expect(chatCoreMocks.convexMutation).toHaveBeenCalledTimes(1)
    expect(chatCoreMocks.convexMutation).toHaveBeenCalledWith({
      runId: "run_new_dispatch",
    })
  })

  it("renders the winning tab's canonical approval reason and reports an already-resolved click", async () => {
    chatCoreMocks.approveToolCall.mockResolvedValue({
      status: "denied",
      alreadyResolved: true,
      reason: "Denied in the other tab",
    })
    mount()

    await act(async () => {
      await coreRef.current?.handleToolApproval(
        "approval_1",
        true,
        "Approve from this tab"
      )
    })

    expect(chatCoreMocks.addToolApprovalResponse).toHaveBeenCalledWith({
      id: "approval_1",
      approved: false,
      reason: "Denied in the other tab",
    })
    expect(chatCoreMocks.toast).toHaveBeenCalledWith({
      title: "Already resolved",
      description: "This approval was decided in another tab.",
      status: "info",
    })
  })
})

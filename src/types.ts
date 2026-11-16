/**
 * Shared domain types and the port interfaces that keep the gateway testable
 * without a real Feishu tenant or a live DSH runtime.
 *
 * Every DSH integration goes through a *port* (SessionBridge, FeishuTransport).
 * The production adapters talk to official DSH services / the official Lark
 * SDK; the test adapters are in-memory. No second agent or LLM session system
 * is defined here.
 */

export type ChatType = 'p2p' | 'group'

export type TransportState =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'closing'
  | 'closed'
  | 'failed'

/** One normalized inbound Feishu `im.message.receive_v1` event. */
export interface InboundMessage {
  /** Feishu `message_id`; the dedup key. */
  readonly messageId: string
  /** Which configured bot received it. */
  readonly botId: string
  readonly chatId: string
  readonly chatType: ChatType
  /** Feishu `open_id` of the sender (the whitelist key). */
  readonly senderId: string
  readonly senderType: string
  /** Extracted plain text (only `text` messages are supported in v0.1.0). */
  readonly text: string
  readonly createTime: number
  readonly messageType: string
  readonly mentionedBot?: boolean
  readonly threadId?: string
  readonly rootId?: string
}

export interface OutboundTarget {
  /** `chat_id` (or `open_id`) destination; used when not replying in-thread. */
  readonly chatId?: string
  /** Feishu receive_id_type for `chatId`; defaults to `chat_id`. */
  readonly receiveIdType?: 'chat_id' | 'open_id'
  /** Feishu `message_id` to reply to (preferred, keeps the conversation). */
  readonly replyToMessageId?: string
  readonly text: string
  /** Optional rich post/md reply; omitted for backward-compatible plain text. */
  readonly format?: 'markdown'
  /**
   * Optional Feishu interactive card (`msg_type: 'interactive'`). When set,
   * the transport sends this card instead of `text`; `text` stays as the
   * durable fallback / audit representation of the same content.
   */
  readonly card?: Record<string, unknown>
  /** Stable per-message idempotency UUID reused on every REST retry. */
  readonly uuid?: string
}

export interface SendReceipt {
  readonly messageId: string
}

export interface CardActionEvent {
  readonly botId: string
  readonly actorOpenId: string
  readonly chatId: string
  readonly messageId: string
  readonly value: { readonly namespace?: string; readonly kind?: string; readonly nonce?: string; readonly decision?: string }
}

/** Model-reported usage for this turn (not a guessed character/token ratio). */
export interface ModelTokenUsage {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cacheReadTokens?: number
  readonly cacheWriteTokens?: number
}

/** Card footer statistics; unknown fields remain omitted. */
export interface CardCompletionStats {
  readonly elapsedMs: number
  readonly model?: string
  readonly usage?: ModelTokenUsage
  /** Measured time between DSH model stream start/end events. */
  readonly generationMs?: number
  readonly toolCalls?: number
  readonly toolFailures?: number
}

/** Sanitized tool progress: no arguments, URLs, command outputs or raw errors. */
export interface SessionToolActivity {
  readonly name: string
  readonly phase: 'started' | 'succeeded' | 'failed'
  readonly httpStatus?: number
  readonly calls: number
  readonly failures: number
}

export interface FeishuCardHandle {
  readonly messageId: string
  readonly cardId?: string
}

export interface FeishuEventHandlers {
  /** Answer native card.action.trigger in under 3 seconds (toast-only). */
  onCardAction?(event: CardActionEvent): Promise<{ toast: { type: string; content: string } }>
  onMessage(message: InboundMessage): void | Promise<void>
  onStateChange(state: TransportState, error?: Error): void
}

/** Port: one long-lived Feishu WebSocket connection for one bot. */
export interface FeishuTransport {
  readonly botId: string
  readonly state: TransportState
  connect(handlers: FeishuEventHandlers): Promise<void>
  close(): Promise<void>
  sendText(target: OutboundTarget): Promise<SendReceipt>
  /** All card methods are optional; older transports keep working. */
  sendInteractiveCard?(target: { replyToMessageId: string }, card: Record<string, unknown>): Promise<FeishuCardHandle>
  updateInteractiveCard?(messageId: string, card: Record<string, unknown>): Promise<void>
  startStreamCard?(target: { replyToMessageId: string }, actionNonce: string): Promise<FeishuCardHandle>
  updateStreamCard?(cardId: string, text: string, sequence: number): Promise<void>
  finishStreamCard?(cardId: string, sequence: number): Promise<void>
  /** Replace the complete CardKit entity, removing the cancel action after settlement. */
  replaceStreamCard?(cardId: string, card: Record<string, unknown>, sequence: number): Promise<void>
}

export interface BotCredentials {
  readonly appId: string
  readonly appSecret: string
  readonly domain: 'feishu' | 'lark'
}

export interface BotSpec {
  readonly id: string
  readonly enabled: boolean
  readonly domain: 'feishu' | 'lark'
  /** Name of the environment variable holding the app id. */
  readonly appIdEnv?: string
  /** Name of the environment variable holding the app secret. */
  readonly appSecretEnv?: string
}

/**
 * Optional proxy selected before DSH starts.
 *
 * The URL is resolved at build time from the admin-managed
 * `<stateDir>/network-proxy.json` (preferred) or the named env var and kept
 * in memory only: it must never be written to logs, diagnostics, telemetry or
 * the managed config file.
 */
export interface NetworkProxyConfig {
  readonly enabled: boolean
  readonly urlEnv: string
  readonly fallbackDirect: boolean
  /** Resolved proxy URL (may contain credentials). In-memory only, never logged. */
  readonly url?: string
}

export type GroupPolicy = 'disabled' | 'allowlist' | 'open'
export type GroupSessionScope = 'group' | 'group_sender' | 'group_topic' | 'group_topic_sender'
export interface GroupRule {
  readonly chatId: string
  readonly enabled: boolean
  readonly name?: string
  readonly requireMention: boolean
  readonly senderAllowlist?: readonly string[]
  readonly sessionScope: GroupSessionScope
}

export interface AgentRoute {
  readonly provider?: string
  readonly model?: string
  readonly reasoningEffort?: string
}

/** Fully resolved plugin configuration (after schema defaults). */
export interface GatewayConfig {
  readonly bots: readonly BotSpec[]
  /** Allowed Feishu `open_id` values. Empty means deny-all (fail closed). */
  readonly allowlist: readonly string[]
  /** Legacy switch never enables group chats. */
  readonly allowGroups: boolean
  readonly groupPolicy: GroupPolicy
  /** Empty means group access is denied even with open policy. */
  readonly groupSenderAllowlist: readonly string[]
  readonly groups: readonly GroupRule[]
  /** Legacy/shared project workspace. Not used as the Feishu Session cwd. */
  readonly workspace: string
  /** Optional dedicated Feishu Agent cwd, separate from the normal DSH workspace. */
  readonly agentWorkspace?: string
  readonly agentPreset?: string
  readonly agent?: AgentRoute
  /** Directory for the durable inbox / outbox / dedup / session map. */
  readonly stateDir: string
  readonly dedupTtlMs: number
  readonly maxDedupEntries: number
  readonly maxTextLength: number
  readonly replyTimeoutMs: number
  readonly networkProxy: NetworkProxyConfig
  /** Default plain text; opt-in rich Markdown for AI answers. */
  readonly replyFormat: 'text' | 'markdown'
  /** Advanced Feishu 2.0 cards (off until real-tenant verification). */
  readonly approvalCards: boolean
  readonly streamCards: boolean
  readonly approvalTimeoutMs: number
  readonly streamIntervalMs: number
  readonly sendRetries: number
  readonly sendRetryBaseDelayMs: number
  /** Recheck parked Outbox replies while the WebSocket stays online (ms). */
  readonly outboxRetryIntervalMs: number
  /** Skip opening WebSocket connections (used by mock/offline profiles). */
  readonly autoConnect: boolean
  /** Hard offline switch: no network calls of any kind. */
  readonly offline: boolean
  readonly diagnoseOnStart: boolean
}

export interface GatewayLogger {
  debug(message: string, ...args: unknown[]): void
  info(message: string, ...args: unknown[]): void
  warn(message: string, ...args: unknown[]): void
  error(message: string, ...args: unknown[]): void
}

export interface SessionReply {
  readonly text: string
  readonly reason: 'idle' | 'timeout' | 'cancelled' | 'empty'
  /** Number of assistant events observed (diagnostics only). */
  readonly assistantEvents?: number
  readonly model?: string
  readonly usage?: ModelTokenUsage
  readonly generationMs?: number
  readonly toolCalls?: number
  readonly toolFailures?: number
}

export interface WaitOptions {
  readonly timeoutMs: number
  readonly signal: AbortSignal
}

/**
 * A turn that DSH's native schedule service injected into one of our Feishu
 * Sessions (`source.kind === 'schedule'`), observed through `session/event`.
 * The Gateway uses it to deliver the Agent's answer back to the Feishu chat.
 */
export interface ObservedScheduleTurn {
  readonly sessionId: string
  /** Native user message id of the delivered occurrence (dedupe key). */
  readonly messageId: string
  readonly text: string
  readonly status: 'success' | 'failed' | 'timeout' | 'empty'
  readonly elapsedMs: number
  readonly model?: string
  readonly tokens?: number
  readonly usage?: ModelTokenUsage
}

/**
 * Port: the bridge to DSH native Sessions.
 *
 * The gateway only ever talks to this. `DshSessionBridge` drives the official
 * `ctx.agents` / `session/event` / `agent/assistant-stream` APIs; it never
 * creates its own LLM loop or Session store.
 */
export interface AvailableModel {
  readonly provider: string
  readonly model: string
  readonly name?: string
}
export interface ModelCatalog {
  readonly models: readonly AvailableModel[]
  readonly incomplete: boolean
}

export interface SessionBridge {
  /** False when the required DSH services are not mounted in this profile. */
  readonly available: boolean
  readonly unavailableReason?: string
  /** Create a fresh native Session under a caller-chosen identity. */
  create(sessionId: string, cwd: string, route?: AgentRoute): Promise<void>
  /** Restore a previously persisted native Session into a live Agent. */
  resume(sessionId: string): Promise<void>
  /** Models advertised by this Gateway Host, not another DSH Profile. */
  listModels?(): Promise<ModelCatalog>
  currentModel?(sessionId: string): { provider: string; model: string } | undefined
  selectModel?(sessionId: string, provider: string, model: string): void
  /** Queue one user turn on a live Session. */
  submit(sessionId: string, text: string, signal: AbortSignal): Promise<void>
  /** Wait for the turn to settle and collect the assistant's reply text. */
  waitForReply(sessionId: string, options: WaitOptions): Promise<SessionReply>
  /**
   * Observe turns that the native DSH schedule service injects directly into a
   * Session (`source.kind === 'schedule'`), without a Gateway `submit()` call.
   * Returns a disposer. Optional so older/test bridges stay compatible.
   */
  watchScheduleTurns?(handler: (turn: ObservedScheduleTurn) => void): () => void
  /** Visible assistant text deltas, never internal reasoning. */
  onTextDelta?(sessionId: string, callback: (text: string) => void): () => void
  onToolActivity?(sessionId: string, callback: (activity: SessionToolActivity) => void): () => void
  /** Cancel the active turn (long-task cancellation hook for v0.2.0). */
  cancel(sessionId: string): void
  /** Release an abandoned Session handle after timeout/error (not normal follow-ups). */
  retire?(sessionId: string): Promise<void>
  /** Release every owned AgentHandle and listener. */
  dispose(): Promise<void>
}

/** Minimal structural view of a Cordis context used by DSH adapters. */
export interface CordisLike {
  get(name: string): unknown
  provide(name: string, value?: unknown): () => void
  /** Listeners may return a value for waterfall events (e.g. schedule/resolve-agent). */
  on(name: string, listener: (...args: any[]) => unknown): () => boolean | void
  effect(execute: () => unknown, label?: string): unknown
  /**
   * Optional service-dependency injection (`ctx.inject(['schedule'], cb)`).
   * Absent in the offline test context; the Gateway degrades to "unavailable".
   */
  inject?(deps: string[], callback: (ctx: CordisLike) => void): unknown
}

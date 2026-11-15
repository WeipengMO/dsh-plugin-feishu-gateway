/** Type declarations for scripts/e2e/lib.mjs (used by the vitest suite). */

export interface EnvSpec {
  readonly purpose: string
  readonly neededFor: readonly string[]
}

export declare const ENV_SPECS: Readonly<Record<string, EnvSpec>>

export declare function requiredEnvNames(opts?: {
  llmMode?: string
  feishuMode?: string
}): string[]

export declare function checkEnv(
  env: Record<string, string | undefined>,
  opts?: { llmMode?: string; feishuMode?: string },
): { present: string[]; missing: string[]; blocked: boolean }

export declare function appIdShapeValid(appId: unknown): boolean

export declare function buildPatch(opts?: {
  llmMode?: 'mock' | 'real'
  feishuMode?: 'offline' | 'live'
  hostMode?: 'oneshot' | 'daemon'
  mockLlmPort?: number
  daemonPort?: number
  stateDir?: string
  workspace?: string
  allowlist?: readonly string[]
  providerId?: string
  baseURL?: string
  modelId?: string
  llmKeyEnv?: string
  probeEnabled?: boolean
  replyTimeoutMs?: number
}): string

export declare function bundlesFor(hostMode: string, pluginName?: string): string[]

export declare const DEFAULT_TOKEN: string

export interface ThreeTurnEvaluation {
  turns: boolean
  sameSessionId: boolean
  firstTurnAcknowledged: boolean
  secondTurnRecalls: boolean
  thirdTurnRecalls: boolean
  bridgeSequence: boolean
  handleDisposedOnce: boolean
  servicesLive: boolean
  noErrors: boolean
  replies: string[]
  sessionId: string | null
}

export declare function evaluateThreeTurns(result: unknown, token?: string): ThreeTurnEvaluation

export declare function evaluateResume(result: unknown, token?: string): {
  sameSessionId: boolean
  recallsToken: boolean
  coldResumeUsed: boolean
  noErrors: boolean
  reply: string
}

export declare function evaluateIsolation(result: unknown): {
  allScenariosPresent: boolean
  allCreateNewSession: boolean
  noOldTextLeaked: boolean
  noCrossAttributedEvents: boolean
}

export declare function verdict(criteria: Record<string, boolean | undefined>): {
  result: 'PASS' | 'FAIL'
  failed: string[]
  criteria: Record<string, boolean | undefined>
}

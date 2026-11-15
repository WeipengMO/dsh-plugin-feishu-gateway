/** Public API of the Gateway-side scheduled-tasks bridge (contract §3). */

export type { ScheduleSpec, SpecValidationResult, NativeTiming } from './spec.js'
export {
  validateSpec, toNativeTiming, previewOccurrences, nativeRecordToSpec, specSummary,
  boundedText, isValidTimeZone, sessionRef,
  MAX_TITLE_LENGTH, MAX_PROMPT_LENGTH, MIN_EVERY_SECONDS,
  MIN_WEEKDAY, MAX_WEEKDAY, MIN_MONTH_DAY, MAX_MONTH_DAY,
  MIN_PREVIEW_COUNT, MAX_PREVIEW_COUNT, PREVIEW_HORIZON_DAYS,
  MAX_ACTOR_LENGTH, MAX_SUMMARY_LENGTH,
} from './spec.js'

export type {
  NativeSchedulePort, NativeTask, NativeDelivery, NativeTarget, NativeList,
  NativeHistory, NativeCodeResult, NativeDeleted, NativeListResult,
  NativeViewResult, NativeHistoryResult, NativeCreateResult, NativeEditResult,
  NativeRunResult, NativeDeleteInactiveResult, NativeDeliveryLimits,
  NativeCreateRequest, NativeEditRequest, NativePatch, ScheduleNativeErrorKind,
} from './native.js'
export { ScheduleNativeError, isScheduleNativeError, createNativeSchedulePort } from './native.js'

export type {
  ScheduleManagerHooks, FeishuDeliveryInput, ScheduleCommand, ScheduleCommandOutcome,
  ObservedScheduleTurn, DeliveryConfig, ScheduleTaskView, ScheduleRunRecord,
  ScheduleAuditEntry, ScheduleReadModel,
} from './manager.js'
export { ScheduleManager } from './manager.js'

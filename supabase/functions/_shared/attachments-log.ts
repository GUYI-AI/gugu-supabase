import { createSafeLogger, type SafeLogFields } from './safe-log.ts'

export const logAttachment = createSafeLogger('attachments', {
  not_configured: 'error', failed: 'error', replacement_finish_failed: 'error',
  gc_abandon_failed: 'error', cdn_refresh_failed: 'warn', gc_failed: 'error',
  gc_fail_report_failed: 'error', gc_result: 'info', gc_result_log_failed: 'error',
})
export type AttachmentLogEvent = Parameters<typeof logAttachment>[0]
export type AttachmentLogFields = SafeLogFields

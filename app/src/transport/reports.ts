import { supabase } from './supabaseClient';

export type ReportInput = {
  channelId: string;
  reportedUserId: string;
  /** The message being reported, when there is one. */
  messageId?: string;
  /**
   * What the reporter chooses to show: the message's text, or a placeholder
   * for a photo or a recording. The one path by which message content reaches
   * the server readable -- and only because a participant decided to send it
   * (supabase/migrations/0029_reports_and_restrictions.sql).
   */
  content?: string;
};

export class ReportLimitError extends Error {
  constructor() {
    super('Too many reports today');
    this.name = 'ReportLimitError';
  }
}

/**
 * Sends a report to the developer, who is emailed at once and must act
 * within a day (Guideline 1.2). Stored on the server rather than sent from
 * the phone's mail app, so it works with no mail account set up, and the
 * person gets a clear "sent" instead of a draft they may never send.
 */
export async function sendReport(report: ReportInput): Promise<void> {
  const { error } = await supabase.from('reports').insert({
    channel_id: report.channelId,
    reported_user_id: report.reportedUserId,
    message_id: report.messageId && !report.messageId.startsWith('local-') ? report.messageId : null,
    content: report.content ? report.content.slice(0, 4000) : null,
  });
  if (error) {
    if (error.message.includes('report_limit')) throw new ReportLimitError();
    throw new Error(error.message);
  }
}

/** Whether a failed send was refused because this account is suspended or expelled. */
export function isAccountRestrictedError(error: unknown): boolean {
  const text =
    error instanceof Error
      ? error.message
      : typeof error === 'object' && error !== null && 'message' in error
        ? String((error as { message: unknown }).message)
        : String(error);
  return text.includes('account_restricted');
}

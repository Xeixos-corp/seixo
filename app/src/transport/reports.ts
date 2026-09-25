import * as Crypto from 'expo-crypto';
import * as FileSystem from 'expo-file-system';
import { supabase, SUPABASE_URL, SUPABASE_ANON_KEY } from './supabaseClient';

/** A received photo or recording the reporter chooses to send with the report. */
export type ReportEvidence = {
  kind: 'photo' | 'voice';
  /** A file on this phone, already decrypted. */
  uri: string;
  contentType: 'image/jpeg' | 'audio/mp4';
};

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
  /**
   * The photo or recording itself (migration 0031). Without it a report of a
   * picture reached the developer as the word "[photo]", which nobody can
   * judge. Kept in a private bucket and deleted with the report.
   */
  evidence?: ReportEvidence;
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
 *
 * The id is made here so the evidence can be uploaded under it: the reporter
 * cannot read the reports table back to learn an id the server chose.
 */
export async function sendReport(report: ReportInput): Promise<void> {
  const id = Crypto.randomUUID();
  const { error } = await supabase.from('reports').insert({
    id,
    channel_id: report.channelId,
    reported_user_id: report.reportedUserId,
    message_id: report.messageId && !report.messageId.startsWith('local-') ? report.messageId : null,
    content: report.content ? report.content.slice(0, 4000) : null,
    evidence_kind: report.evidence?.kind ?? null,
  });
  if (error) {
    if (error.message.includes('report_limit')) throw new ReportLimitError();
    throw new Error(error.message);
  }

  // After the report exists, because the storage policy only accepts a file
  // named after one of the reporter's own recent reports. A failed upload
  // leaves the report standing -- the developer's page says the file did not
  // arrive -- rather than throwing away the report itself.
  if (report.evidence) {
    try {
      await uploadEvidence(id, report.evidence);
    } catch (uploadError) {
      console.warn('[report] evidence did not upload', uploadError instanceof Error ? uploadError.message : 'error');
    }
  }
}

async function uploadEvidence(reportId: string, evidence: ReportEvidence): Promise<void> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error('No session');
  const result = await FileSystem.uploadAsync(
    `${SUPABASE_URL}/storage/v1/object/report-evidence/${reportId}`,
    evidence.uri,
    {
      httpMethod: 'POST',
      uploadType: FileSystem.FileSystemUploadType.BINARY_CONTENT,
      headers: {
        Authorization: `Bearer ${token}`,
        apikey: SUPABASE_ANON_KEY,
        'Content-Type': evidence.contentType,
        'cache-control': 'no-store',
        'x-upsert': 'false',
      },
    },
  );
  if (result.status < 200 || result.status >= 300) {
    throw new Error(`upload refused (${result.status})`);
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

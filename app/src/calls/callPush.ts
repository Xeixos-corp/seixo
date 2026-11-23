import * as Application from 'expo-application';
import { supabase } from '../transport/supabaseClient';

/**
 * Asks the server to wake the other phone with a VoIP push, so it rings even
 * when Seixo is closed there (supabase/functions/call-push).
 *
 * This is the one point where the server learns a call is being made: that
 * this account asked for the other member of this conversation to be rung,
 * at this moment. Not whether it was answered, not for how long, and nothing
 * of what was said. Without it, a call could only reach a phone with the app
 * already open. The push itself carries only the call's random id.
 */
export async function requestCallPush(channelId: string, callId: string): Promise<void> {
  const { error } = await supabase.functions.invoke('call-push', {
    body: { channel_id: channelId, call_id: callId },
  });
  if (error) throw error;
}

/**
 * Stores this phone's VoIP token, separate from the ordinary push token: it
 * is a different token, for a different kind of push, and it exists even
 * when notifications are turned off.
 *
 * Which app it belongs to travels with it: Seixo Dev has its own bundle id,
 * and a push sent under the other app's name simply fails.
 */
export async function upsertVoipToken(userId: string, token: string): Promise<void> {
  const bundleId = Application.applicationId ?? '';
  const { error } = await supabase.from('voip_tokens').upsert(
    {
      user_id: userId,
      token,
      topic: `${bundleId}.voip`,
      // Production for both apps. Seixo Dev is installed as an ad hoc build,
      // and ad hoc builds talk to Apple's production push servers; sending its
      // token to the sandbox got "BadDeviceToken" (2026-11-22). The column
      // stays for a build ever signed for development.
      sandbox: false,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'user_id' },
  );
  if (error) throw new Error(error.message);
}

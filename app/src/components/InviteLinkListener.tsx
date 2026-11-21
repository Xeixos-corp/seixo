import { useEffect } from 'react';
import * as Linking from 'expo-linking';
import { findInviteCode } from '../transport/invites';
import { usePendingInviteStore } from '../store/pendingInviteStore';

/**
 * Catches invite links: the universal link (https://xeixos-corp.github.io/c/#...)
 * when Seixo is installed, and seixo://invite#... from the page's button
 * after it has just been installed. Only notes the code; the conversation
 * list asks the person and does the rest (ConversationListScreen.tsx).
 *
 * Share-extension URLs (seixo://dataUrl=...) are left alone: they carry no
 * invite, so findInviteCode ignores them.
 */
export function InviteLinkListener(): null {
  const setCode = usePendingInviteStore((state) => state.setCode);

  useEffect(() => {
    const handle = (url: string | null) => {
      if (!url) return;
      const code = findInviteCode(url);
      if (code) setCode(code);
    };
    void Linking.getInitialURL().then(handle);
    const subscription = Linking.addEventListener('url', (event) => handle(event.url));
    return () => subscription.remove();
  }, [setCode]);

  return null;
}

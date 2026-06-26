import { useEffect } from 'react';
import { useConfig } from './ConfigContext';
import { pushCarosToken } from '../utils/carosAuth';

/**
 * Mounted once at the app root. The main process renews the Entra token in the
 * background (~30 min) and broadcasts it; here we write the fresh bearer into
 * goosed config so long-running sessions never send an expired token.
 */
export default function CarosAuthRenewal() {
  const { upsert } = useConfig();

  useEffect(() => {
    const unsubscribe = window.electron.carosAuth.onTokenRenewed(async (token) => {
      try {
        await pushCarosToken(upsert, token);
      } catch (error) {
        console.error('[caros] failed to persist renewed token:', error);
      }
    });
    return unsubscribe;
  }, [upsert]);

  return null;
}

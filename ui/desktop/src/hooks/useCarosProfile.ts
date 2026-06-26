import { useEffect, useState } from 'react';

export interface CarosProfile {
  signedIn: boolean;
  name?: string;
  email?: string;
  avatarDataUrl?: string;
}

/**
 * Signed-in Microsoft user (name / email / Graph avatar) from the main-process
 * MSAL module. Refreshes when the background token-renewal broadcasts.
 */
export function useCarosProfile(): CarosProfile | null {
  const [profile, setProfile] = useState<CarosProfile | null>(null);

  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const status = await window.electron.carosAuth.status();
        if (active) setProfile(status);
      } catch {
        if (active) setProfile({ signedIn: false });
      }
    };
    load();
    const unsubscribe = window.electron.carosAuth.onTokenRenewed(() => load());
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  return profile;
}

/** Initials for the avatar fallback when no Graph photo is available. */
export function profileInitials(profile: CarosProfile | null): string {
  const source = profile?.name || profile?.email || '';
  const parts = source.split(/[\s.@]+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0]!.charAt(0).toUpperCase();
  return (parts[0]!.charAt(0) + parts[1]!.charAt(0)).toUpperCase();
}

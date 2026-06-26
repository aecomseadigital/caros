import { useState } from 'react';
import { useConfig } from '../../ConfigContext';
import { Button } from '../../ui/button';
import { useCarosProfile, profileInitials } from '../../../hooks/useCarosProfile';
import { defineMessages, useIntl } from '../../../i18n';

const i18n = defineMessages({
  heading: { id: 'account.heading', defaultMessage: 'Account' },
  signedInAs: { id: 'account.signedInAs', defaultMessage: 'Signed in with your Microsoft work account.' },
  notSignedIn: { id: 'account.notSignedIn', defaultMessage: 'Not signed in.' },
  signOut: { id: 'account.signOut', defaultMessage: 'Sign out' },
  signingOut: { id: 'account.signingOut', defaultMessage: 'Signing out…' },
});

export default function AccountSection() {
  const intl = useIntl();
  const profile = useCarosProfile();
  const { remove } = useConfig();
  const [signingOut, setSigningOut] = useState(false);

  const handleSignOut = async () => {
    setSigningOut(true);
    try {
      await window.electron.carosAuth.signOut();
      // Clear the bearer + provider so the app returns to the sign-in screen.
      await Promise.allSettled([
        remove('CAROS_TOKEN', true),
        remove('CAROS_REFRESH_TOKEN', true),
        remove('CAROS_TOKEN_EXPIRY', false),
        remove('GOOSE_PROVIDER', false),
      ]);
    } finally {
      window.electron.reloadApp();
    }
  };

  return (
    <div className="space-y-6 pb-8">
      <h2 className="text-2xl font-light">{intl.formatMessage(i18n.heading)}</h2>

      <div className="flex items-center gap-4 rounded-lg border border-border-subtle p-4">
        {profile?.avatarDataUrl ? (
          <img
            src={profile.avatarDataUrl}
            alt={profile.name ?? ''}
            className="size-16 rounded-full object-cover"
          />
        ) : (
          <div className="size-16 rounded-full bg-background-tertiary flex items-center justify-center text-xl font-medium text-text-secondary">
            {profileInitials(profile)}
          </div>
        )}
        <div className="min-w-0">
          {profile?.signedIn ? (
            <>
              <div className="text-lg font-medium truncate">{profile.name || profile.email}</div>
              {profile.email && <div className="text-text-muted truncate">{profile.email}</div>}
              <div className="text-text-muted text-sm mt-1">{intl.formatMessage(i18n.signedInAs)}</div>
            </>
          ) : (
            <div className="text-text-muted">{intl.formatMessage(i18n.notSignedIn)}</div>
          )}
        </div>
      </div>

      <Button onClick={handleSignOut} disabled={signingOut} variant="destructive">
        {signingOut ? intl.formatMessage(i18n.signingOut) : intl.formatMessage(i18n.signOut)}
      </Button>
    </div>
  );
}

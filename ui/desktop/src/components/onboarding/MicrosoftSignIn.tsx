import { useState } from 'react';
import { useConfig } from '../ConfigContext';
import { Button } from '../ui/button';
import { pushCarosToken } from '../../utils/carosAuth';
import { defineMessages, useIntl } from '../../i18n';

const i18n = defineMessages({
  title: {
    id: 'carosSignIn.title',
    defaultMessage: 'Sign in to continue',
  },
  description: {
    id: 'carosSignIn.description',
    defaultMessage: 'Caros uses your Microsoft work account. Access requires the Caros app role.',
  },
  button: {
    id: 'carosSignIn.button',
    defaultMessage: 'Sign in with Microsoft',
  },
  signingIn: {
    id: 'carosSignIn.signingIn',
    defaultMessage: 'Waiting for sign-in…',
  },
});

interface MicrosoftSignInProps {
  /** OnboardingGuard's handleConfigured — finalizes provider/model selection. */
  onConfigured: (providerName: string, modelId?: string) => Promise<void>;
}

export default function MicrosoftSignIn({ onConfigured }: MicrosoftSignInProps) {
  const intl = useIntl();
  const { upsert } = useConfig();
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSignIn = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const token = await window.electron.carosAuth.signIn();
      await pushCarosToken(upsert, token);
      await onConfigured('caros', 'gpt-5.4-auto');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="flex flex-col items-start gap-3">
      <h2 className="text-lg font-medium">{intl.formatMessage(i18n.title)}</h2>
      <p className="text-text-muted">{intl.formatMessage(i18n.description)}</p>
      <Button onClick={handleSignIn} disabled={isLoading}>
        {isLoading ? intl.formatMessage(i18n.signingIn) : intl.formatMessage(i18n.button)}
      </Button>
      {error && <p className="text-text-error text-sm">{error}</p>}
    </div>
  );
}

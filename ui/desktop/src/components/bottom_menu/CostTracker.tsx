import { useState, useEffect } from 'react';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/Tooltip';
import { defineMessages, useIntl } from '../../i18n';

const i18n = defineMessages({
  tokensTooltip: {
    id: 'costTracker.tokensTooltip',
    defaultMessage: 'Input: {inputTokens} tokens · Output: {outputTokens} tokens',
  },
});

interface CostTrackerProps {
  inputTokens?: number;
  outputTokens?: number;
  accumulatedCost?: number | null;
  model: string | null;
  provider: string | null;
}

/** Format a token count to 3 significant figures with a K/M/B suffix, e.g. 12345 -> "12.3K". */
function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  const units = [
    { v: 1_000_000_000, s: 'B' },
    { v: 1_000_000, s: 'M' },
    { v: 1_000, s: 'K' },
  ];
  const unit = units.find((u) => n >= u.v)!;
  const scaled = n / unit.v;
  const digits = scaled >= 100 ? 0 : scaled >= 10 ? 1 : 2;
  return `${scaled.toFixed(digits)}${unit.s}`;
}

export function CostTracker({ inputTokens = 0, outputTokens = 0 }: CostTrackerProps) {
  const intl = useIntl();
  const [showPricing, setShowPricing] = useState(true);

  // The "Show model pricing and usage costs" setting also gates this token counter.
  useEffect(() => {
    const loadSetting = async () => {
      const enabled = await window.electron.getSetting('showPricing');
      setShowPricing(enabled);
    };
    loadSetting();
    const handleChange = () => loadSetting();
    window.addEventListener('showPricingChanged', handleChange);
    return () => window.removeEventListener('showPricingChanged', handleChange);
  }, []);

  if (!showPricing) {
    return null;
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className="flex items-center justify-center h-full transition-colors cursor-default translate-y-[1px] text-text-primary/70 hover:text-text-primary">
          <span className="text-xs font-mono">
            {formatTokens(inputTokens)} / {formatTokens(outputTokens)} tokens
          </span>
        </div>
      </TooltipTrigger>
      <TooltipContent>
        {intl.formatMessage(i18n.tokensTooltip, {
          inputTokens: inputTokens.toLocaleString(),
          outputTokens: outputTokens.toLocaleString(),
        })}
      </TooltipContent>
    </Tooltip>
  );
}

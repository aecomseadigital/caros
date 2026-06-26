import { useMemo, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '../ui/dialog';
import { Button } from '../ui/button';
import { useConfig } from '../ConfigContext';
import { View, ViewOptions } from '../../utils/navigationUtils';
import { addExtensionFromDeepLink } from '../settings/extensions/deeplink';
import catalog from './browse-catalog.json';

interface CatalogEntry {
  name: string;
  description: string;
  install: string | null;
}

const ENTRIES = catalog as unknown as CatalogEntry[];

interface BrowseExtensionsModalProps {
  isOpen: boolean;
  onClose: () => void;
  // Optional: needed so extensions that require env vars / headers can navigate
  // to the configuration form after install. Omitted at call sites without it.
  setView?: (view: View, options?: ViewOptions) => void;
}

export default function BrowseExtensionsModal({
  isOpen,
  onClose,
  setView,
}: BrowseExtensionsModalProps) {
  const { addExtension } = useConfig();
  const [query, setQuery] = useState('');
  const [installing, setInstalling] = useState<string | null>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return ENTRIES;
    return ENTRIES.filter(
      (e) => e.name.toLowerCase().includes(q) || e.description.toLowerCase().includes(q)
    );
  }, [query]);

  const handleInstall = async (entry: CatalogEntry) => {
    if (!entry.install) return;
    setInstalling(entry.name);
    try {
      await addExtensionFromDeepLink(entry.install, addExtension, (view: string, options?: ViewOptions) => {
        setView?.(view as View, options);
      });
      onClose();
    } catch (error) {
      console.error('Failed to install extension:', error);
    } finally {
      setInstalling(null);
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>Browse Extensions</DialogTitle>
          <DialogDescription>
            Discover and install Caros extensions. Each runs via the Model Context Protocol and is
            added as a default for new chats.
          </DialogDescription>
        </DialogHeader>

        <input
          type="search"
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search extensions"
          className="w-full bg-transparent border-b border-black/10 dark:border-white/15 text-base py-2 outline-none"
        />
        <div className="text-xs text-text-secondary mt-2">{filtered.length} extensions</div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-3 max-h-[55vh] overflow-y-auto pr-1">
          {filtered.map((entry) => (
            <div
              key={entry.name}
              className="flex flex-col rounded-lg border border-black/10 dark:border-white/10 p-4"
            >
              <h3 className="text-sm font-medium mb-1">{entry.name}</h3>
              <p className="text-xs text-text-secondary flex-1 mb-3">{entry.description}</p>
              {entry.install ? (
                <Button
                  variant="secondary"
                  className="self-start h-8 px-3 text-xs"
                  disabled={installing !== null}
                  onClick={() => handleInstall(entry)}
                >
                  {installing === entry.name ? 'Installing…' : 'Install'}
                </Button>
              ) : (
                <span className="text-xs text-text-secondary italic self-start">
                  Manual setup required
                </span>
              )}
            </div>
          ))}
          {filtered.length === 0 && (
            <p className="text-sm text-text-secondary col-span-full py-8 text-center">
              No extensions match “{query}”.
            </p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

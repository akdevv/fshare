import { useEffect, useState } from 'react';
import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';

// Only the installed app can receive shares; in Expo Go the native side is missing.
const canReceive = (() => {
  try {
    Sharing.getSharedPayloads();
    return true;
  } catch {
    return false;
  }
})();
const useIncomingShare = canReceive ? Sharing.useIncomingShare : () => null;

// Files shared into fshare from another app (Gallery › Share › fshare), waiting to be sent.
export function useOutbox() {
  const share = useIncomingShare();
  const [outbox, setOutbox] = useState<File[]>([]);
  const payloads = share?.resolvedSharedPayloads ?? [];
  useEffect(() => {
    if (!payloads.length) return;
    const files = payloads.flatMap((p): File[] => {
      if (p.contentUri && p.contentType !== 'text' && p.contentType !== 'website') return [new File(p.contentUri)];
      if (!p.value) return [];
      // a shared link or note becomes a text file
      const f = new File(Paths.cache, `Shared text ${new Date().toISOString().slice(0, 19).replace(/:/g, '.')}.txt`);
      f.write(p.value);
      return [f];
    });
    share!.clearSharedPayloads();
    setOutbox((o) => [...o, ...files]);
  }, [payloads]);
  return [outbox, () => setOutbox([])] as const;
}

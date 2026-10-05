// Phone-to-phone support. Native code exists in the installed app (Android: Wi-Fi + USB cable,
// iOS: Wi-Fi); in Expo Go this is null and the app works laptop-only.
import { requireOptionalNativeModule } from 'expo';
import Constants from 'expo-constants';

type EventSubscription = { remove(): void };

export type PairRequest = { id: string; name: string; host: string; port: number; token: string; peer: string }; // peer: the asking phone's app id
export type Incoming = { id: string; name: string; from: string; done: number; total: number };
export type Received = { id: string; name: string; from: string; uri: string; size: number };
export type Stopped = { id: string; reason: 'paused' | 'cancelled' | 'expired'; done?: number }; // expired: kept 5 min, never resumed
export type Found = { name: string; host: string; port: number; id: string; hidden: boolean };

type Events = {
  pairRequest: (e: PairRequest) => void;
  progress: (e: Incoming) => void;
  received: (e: Received) => void;
  stopped: (e: Stopped) => void;
  peerFound: (e: Found) => void;
  peerLost: (e: { name: string }) => void;
  usb: (e: { state: 'connected' | 'disconnected'; role?: 'host' | 'accessory' }) => void;
};

type PeerModule = {
  deviceName(): string | null; // null on iOS: expo-constants has it
  start(token: string, name: string, id: string, visible: boolean): void;
  setVisible(visible: boolean): void;
  // keep running while minimized (Android: foreground service + ongoing notification; iOS: background task)
  background(on: boolean, title: string, text: string, progress: number): void;
  answerPair(id: string, ok: boolean): void;
  cancel(id: string): void;
  addListener<K extends keyof Events>(event: K, fn: Events[K]): EventSubscription;
};

export const Peer = requireOptionalNativeModule<PeerModule>('FsharePeer');
export const SERVER_PORT = 4748;
export const CABLE = 'http://127.0.0.1:4749';

// how this phone introduces itself to laptops and other phones
export const myName: string = Peer?.deviceName() ?? Constants.deviceName ?? 'Phone';

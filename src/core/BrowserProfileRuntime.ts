import type { BrowserContext } from 'playwright';
import type { BrowserPageRef } from './BrowserPageRegistry';

export interface BrowserProfileRuntime {
  readonly profileId: string;
  readonly runtimeId: string;

  start(): Promise<void>;
  stop(): Promise<void>;
  restart(): Promise<void>;
  recover(): Promise<void>;

  isRunning(): boolean;
  isResponsive(): Promise<boolean>;
  context(): Promise<BrowserContext>;
  currentPages(): BrowserPageRef[];
}

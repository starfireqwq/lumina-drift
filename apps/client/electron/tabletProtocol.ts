export type TabletPreference = 'auto' | 'ink' | 'wintab';
export type TabletMode = 'browser' | 'ink' | 'wintab';
export type WinTabStatus = 'disabled' | 'bridge-unavailable' | 'driver-missing' | 'driver-unavailable'
  | 'no-pressure-axis' | 'context-failed' | 'ready';

export interface WinTabSample {
  x: number;
  y: number;
  time: number;
  cursor: number;
  pressure: number;
  contact: boolean;
  eraser?: boolean;
  serial?: number;
  gapBefore?: boolean;
  down?: boolean;
  newestInMessage?: boolean;
  capturedAt?: number;
  messageAt?: number;
  forwardedAt?: number;
  drainedAt?: number;
}

export type InkSample = Pick<WinTabSample, 'x' | 'y' | 'time' | 'contact'> & { eraser: boolean };

export interface WinTabUpdate {
  status: WinTabStatus;
  generation: number;
  samples: WinTabSample[];
  publishedAt?: number;
  dispatch?: 'capture' | 'pointer' | 'status';
  devicesChanged?: boolean;
  inkSample?: InkSample | null;
  inkSamples?: WinTabSample[];
  mouseSamples?: WinTabSample[];
  mouseCapture?: 'starting' | 'ready' | 'unavailable';
}

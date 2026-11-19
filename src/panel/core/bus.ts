// A tiny typed event bus between panel modules.
import type { NetEntry } from '../../shared/messages';
import type { PanelError } from './state';

export type TabName = 'inspect' | 'console' | 'network' | 'requests';
export interface BusEvents {
  counts: undefined;
  error: PanelError;
  'errors-cleared': undefined;
  'errors-mapped': undefined;
  'to-requests': NetEntry;
  'goto-tab': TabName;
  'goto-errors': undefined;
  'settings-changed': undefined;
}
type Handler<K extends keyof BusEvents> = (data: BusEvents[K]) => void;

const listeners = new Map<keyof BusEvents, ((data: never) => void)[]>();

export function on<K extends keyof BusEvents>(name: K, fn: Handler<K>): void {
  const list = listeners.get(name) ?? [];
  list.push(fn);
  listeners.set(name, list);
}
export function emit<K extends keyof BusEvents>(name: K, ...data: BusEvents[K] extends undefined ? [] : [BusEvents[K]]): void {
  // Handlers registered under `name` all take BusEvents[K] (see `on`).
  for (const fn of (listeners.get(name) ?? []) as Handler<K>[]) fn(data[0] as BusEvents[K]);
}

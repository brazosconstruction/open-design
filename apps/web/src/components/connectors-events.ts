export const CONNECTOR_CALLBACK_MESSAGE_TYPE = 'open-design:connector-connected';
export const CONNECTORS_CHANGED_EVENT = 'open-design:connectors-changed';

export function notifyConnectorsChanged(): void {
  if (typeof window === 'undefined') return;
  try {
    window.dispatchEvent(new CustomEvent(CONNECTORS_CHANGED_EVENT));
  } catch {
    window.dispatchEvent(new Event(CONNECTORS_CHANGED_EVENT));
  }
}

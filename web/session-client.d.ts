export type BrowserSessionStatus = {
  state: 'disconnected' | 'connecting' | 'connected' | 'recovering';
  reason?: 'reconnecting' | 'resumed' | 'new_session' | 'credential_expired' | 'offline' | 'token_required';
  attempt?: number;
  retryInMs?: number;
  connectionId?: string;
  sessionId?: string;
};

export function isLoopbackHost(hostname: string): boolean;
export function browserReconnectDelay(attempt: number, random?: () => number): number;

export class BrowserSessionClient {
  constructor(options: any);
  socket?: WebSocket;
  credential(): { clientId: string; sessionId: string; secret: string; expiresAt: number } | undefined;
  connect(token?: string): boolean;
  resumeIfAvailable(): boolean;
  send(value: Record<string, unknown>): boolean;
  sendBinary(value: ArrayBuffer | ArrayBufferView): boolean;
  repeatLastSubmission(): boolean;
  simulateDrop(): boolean;
  simulateExpiry(): boolean;
  networkAvailable(): boolean;
  confirmExit(confirm: boolean): boolean;
  dispose(): void;
}

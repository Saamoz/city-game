import { io, type Socket } from 'socket.io-client';

export interface TestSocketClientOptions {
  url?: string;
  cookie?: string;
}

export function createSocketClient(
  options: TestSocketClientOptions = {},
): Socket {
  return io(options.url ?? 'http://localhost:3000', {
    autoConnect: false,
    extraHeaders: options.cookie
      ? {
          Cookie: options.cookie,
        }
      : undefined,
  });
}

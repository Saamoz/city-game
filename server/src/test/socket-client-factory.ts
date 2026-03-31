import { io, type Socket } from 'socket.io-client';

export interface TestSocketClientOptions {
  url?: string;
  cookie?: string;
}

export function createSocketClient(options: TestSocketClientOptions = {}): Socket {
  return io(options.url ?? 'http://localhost:3000', {
    autoConnect: false,
    extraHeaders: options.cookie
      ? {
          Cookie: options.cookie,
        }
      : undefined,
  });
}

export async function connectSocketClient(socket: Socket): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const onConnect = () => {
      cleanup();
      resolve(socket);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      socket.off('connect', onConnect);
      socket.off('connect_error', onError);
    };

    socket.on('connect', onConnect);
    socket.on('connect_error', onError);
    socket.connect();
  });
}

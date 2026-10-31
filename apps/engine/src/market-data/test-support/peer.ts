import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';

/** Minimal real RFC6455 test peer; production client is Node's native WebSocket. */
export async function localPeer(ack = true) {
  const sockets: Duplex[] = [];
  const requests: { connection: number; message: Record<string, unknown> }[] = [];
  const server = createServer();
  server.on('upgrade', (request, socket) => {
    const key = request.headers['sec-websocket-key'];
    if (typeof key !== 'string') {
      socket.destroy();
      return;
    }
    const accept = createHash('sha1')
      .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest('base64');
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    const connection = sockets.push(socket) - 1;
    let buffered = Buffer.alloc(0);
    socket.on('error', () => {});
    socket.on('data', (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      while (buffered.length >= 2) {
        const opcode = buffered[0]! & 15;
        const masked = (buffered[1]! & 128) !== 0;
        let length = buffered[1]! & 127;
        let offset = 2;
        if (length === 126) {
          if (buffered.length < 4) return;
          length = buffered.readUInt16BE(2);
          offset = 4;
        }
        if (length === 127) {
          socket.destroy();
          return;
        }
        if (!masked) {
          socket.destroy();
          return;
        }
        if (buffered.length < offset + 4 + length) return;
        const mask = buffered.subarray(offset, offset + 4);
        offset += 4;
        const payload = Buffer.from(buffered.subarray(offset, offset + length));
        for (let index = 0; index < payload.length; index++)
          payload[index] = payload[index]! ^ mask[index % 4]!;
        buffered = buffered.subarray(offset + length);
        if (opcode === 8) {
          socket.end(Buffer.from([0x88, 0]));
          return;
        }
        if (opcode !== 1) continue;
        const message = JSON.parse(payload.toString()) as Record<string, unknown>;
        requests.push({ connection, message });
        if (ack) {
          // Reverse completion order exercises ID matching instead of ACK position.
          const delay = message.method === 'slotSubscribe' ? 0 : message.id === 1 ? 10 : 5;
          setTimeout(
            () =>
              send(connection, {
                jsonrpc: '2.0',
                id: message.id,
                result: Number(message.id) + 100,
              }),
            delay,
          );
        }
      }
    });
  });
  const send = (connection: number, message: unknown) => {
    const data = Buffer.from(typeof message === 'string' ? message : JSON.stringify(message));
    const prefix =
      data.length < 126
        ? Buffer.from([0x81, data.length])
        : Buffer.from([0x81, 126, data.length >> 8, data.length & 255]);
    sockets[connection]?.write(Buffer.concat([prefix, data]));
  };
  await new Promise<void>((resolve, reject) =>
    server.once('error', reject).listen(0, '127.0.0.1', resolve),
  );
  return {
    url: `ws://127.0.0.1:${(server.address() as AddressInfo).port}`,
    sockets,
    requests,
    send,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

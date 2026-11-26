import crypto from 'node:crypto';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/**
 * Compute RFC 6455 Sec-WebSocket-Accept header value.
 */
export function computeWebSocketAccept(key) {
  return crypto.createHash('sha1').update(`${String(key).trim()}${WS_GUID}`).digest('base64');
}

/**
 * Encode a WebSocket frame from the server (unmasked).
 */
export function encodeWebSocketFrame(opcode, payloadBuffer) {
  const payload = Buffer.isBuffer(payloadBuffer) ? payloadBuffer : Buffer.from(String(payloadBuffer || ''), 'utf8');
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x80 | (opcode & 0x0f);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | (opcode & 0x0f);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | (opcode & 0x0f);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

/**
 * Upgrade an HTTP request/socket to a lightweight RFC 6455 WebSocket connection.
 */
export function acceptWebSocketUpgrade(request, socket, head) {
  const key = request.headers['sec-websocket-key'];
  if (!key) {
    socket.destroy();
    return null;
  }
  const accept = computeWebSocketAccept(key);
  socket.write(
    [
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${accept}`,
      '',
      ''
    ].join('\r\n')
  );

  let buffer = head && head.length ? Buffer.from(head) : Buffer.alloc(0);
  let closed = false;
  let fragmentOpcode = null;
  let fragmentChunks = [];
  const messageHandlers = new Set();
  const closeHandlers = new Set();

  const cleanup = () => {
    if (closed) return;
    closed = true;
    for (const handler of closeHandlers) {
      try {
        handler();
      } catch {}
    }
    messageHandlers.clear();
    closeHandlers.clear();
  };

  const sendRaw = (opcode, data) => {
    if (closed || socket.destroyed) return false;
    try {
      socket.write(encodeWebSocketFrame(opcode, data));
      return true;
    } catch {
      cleanup();
      return false;
    }
  };

  const close = (code = 1000, reason = '') => {
    if (closed) return;
    const reasonBuf = Buffer.from(String(reason || ''), 'utf8');
    const payload = Buffer.alloc(2 + reasonBuf.length);
    payload.writeUInt16BE(code, 0);
    reasonBuf.copy(payload, 2);
    sendRaw(0x08, payload);
    cleanup();
    try {
      socket.end();
    } catch {}
  };

  const parseFrames = () => {
    while (buffer.length >= 2 && !closed) {
      const firstByte = buffer[0];
      const secondByte = buffer[1];
      const fin = Boolean(firstByte & 0x80);
      const opcode = firstByte & 0x0f;
      const masked = Boolean(secondByte & 0x80);
      let payloadLen = secondByte & 0x7f;
      let offset = 2;

      if (payloadLen === 126) {
        if (buffer.length < 4) return;
        payloadLen = buffer.readUInt16BE(2);
        offset = 4;
      } else if (payloadLen === 127) {
        if (buffer.length < 10) return;
        const bigLen = buffer.readBigUInt64BE(2);
        if (bigLen > 16n * 1024n * 1024n) {
          close(1009, 'Frame too large');
          return;
        }
        payloadLen = Number(bigLen);
        offset = 10;
      }

      const maskBytes = masked ? 4 : 0;
      if (buffer.length < offset + maskBytes + payloadLen) return;

      const maskKey = masked ? buffer.subarray(offset, offset + 4) : null;
      offset += maskBytes;
      const payload = Buffer.from(buffer.subarray(offset, offset + payloadLen));
      buffer = buffer.subarray(offset + payloadLen);

      if (maskKey) {
        for (let i = 0; i < payload.length; i++) {
          payload[i] ^= maskKey[i % 4];
        }
      }

      if (opcode === 0x08) {
        close(1000, 'Client closed');
        return;
      }
      if (opcode === 0x09) {
        sendRaw(0x0a, payload);
        continue;
      }
      if (opcode === 0x0a) {
        continue;
      }

      if (opcode === 0x00) {
        if (fragmentOpcode === null) {
          close(1002, 'Unexpected continuation frame');
          return;
        }
        fragmentChunks.push(payload);
        if (fin) {
          const full = Buffer.concat(fragmentChunks);
          const resolvedOpcode = fragmentOpcode;
          fragmentOpcode = null;
          fragmentChunks = [];
          const value = resolvedOpcode === 0x01 ? full.toString('utf8') : full;
          for (const handler of messageHandlers) handler(value);
        }
        continue;
      }

      if (!fin) {
        fragmentOpcode = opcode;
        fragmentChunks = [payload];
        continue;
      }

      const value = opcode === 0x01 ? payload.toString('utf8') : payload;
      for (const handler of messageHandlers) handler(value);
    }
  };

  socket.on('data', (chunk) => {
    if (closed) return;
    buffer = Buffer.concat([buffer, chunk]);
    parseFrames();
  });
  socket.on('close', cleanup);
  socket.on('error', cleanup);
  socket.on('end', cleanup);

  if (buffer.length > 0) {
    queueMicrotask(parseFrames);
  }

  return {
    sendText(text) {
      return sendRaw(0x01, String(text));
    },
    sendJson(obj) {
      return sendRaw(0x01, JSON.stringify(obj));
    },
    onMessage(fn) {
      messageHandlers.add(fn);
      return () => messageHandlers.delete(fn);
    },
    onClose(fn) {
      closeHandlers.add(fn);
      return () => closeHandlers.delete(fn);
    },
    close,
    get isClosed() {
      return closed;
    }
  };
}

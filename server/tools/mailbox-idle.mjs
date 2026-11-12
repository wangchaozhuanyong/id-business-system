import { connect } from 'node:tls';

const hosts = { google: 'imap.gmail.com', apple: 'imap.mail.me.com', microsoft: 'outlook.office365.com' };
const quote = value => {
  if (typeof value !== 'string' || !value || /[\r\n\0]/.test(value)) throw new Error('Invalid mailbox credential');
  return '"' + value.replace(/[\\"]/g, '\\$&') + '"';
};
const failure = code => Object.assign(new Error('Mailbox update connection unavailable'), { code });

// A listen-only RFC 2177 connection. It never fetches mail, logs protocol lines,
// marks messages read, or changes a mailbox. Ordinary reads keep their existing path.
export function watchMailboxImap(item, {
  signal, onChange = () => {}, onError = () => {}, connectTls = connect,
  schedule = setTimeout, cancel = clearTimeout
} = {}) {
  return new Promise((resolve, reject) => {
    const host = hosts[item.provider];
    if (!host || signal?.aborted) return reject(failure('ABORTED'));
    let login;
    try {
      login = item.provider === 'microsoft' ? 'AUTHENTICATE XOAUTH2'
        : 'LOGIN ' + quote(item.email) + ' ' + quote(item.appPassword);
      if (item.provider === 'microsoft' && (!item.accessToken || /[\r\n\0\x01]/.test(item.email + item.accessToken)))
        throw new Error();
    } catch { return reject(failure('AUTH_REJECTED')); }
    let socket, buffer = '', pending, sequence = 0, deadline, renewal, stopped = false;
    let ready = false, selected = false, exists, uidNext, uidValidity, announced = false;
    const handle = { close: () => stop(), get closed() { return stopped; } };
    function stop(error) {
      if (stopped) return;
      stopped = true;
      cancel(deadline); cancel(renewal);
      signal?.removeEventListener('abort', abort);
      socket?.destroy();
      if (!ready) reject(error || failure('ABORTED'));
      else if (error) onError(error);
    }
    function abort() { stop(); }
    function armDeadline() {
      cancel(deadline);
      deadline = schedule(() => stop(failure('UNAVAILABLE')), 10_000);
      deadline?.unref?.();
    }
    function command(text, done, continuation) {
      const tag = 'U' + (++sequence);
      pending = { tag, done, continuation };
      armDeadline();
      socket.write(tag + ' ' + text + '\r\n');
    }
    function idle() {
      let continued = false;
      command('IDLE', status => {
        cancel(renewal);
        if (status !== 'OK') return stop(failure('UNAVAILABLE'));
        idle();
      }, () => {
        if (continued) return stop(failure('UNAVAILABLE'));
        continued = true;
        cancel(deadline);
        // Renewal is protocol keepalive only: DONE / IDLE, without a mail read.
        renewal = schedule(() => {
          if (stopped) return;
          armDeadline();
          socket.write('DONE\r\n');
        }, 25 * 60_000);
        renewal?.unref?.();
        if (!ready) { ready = true; resolve(handle); }
      });
    }
    function authenticate() {
      let challenges = 0;
      command(login, status => {
        login = undefined;
        if (status !== 'OK') return stop(failure('AUTH_REJECTED'));
        let idleSupported = false;
        command('CAPABILITY', capabilityStatus => {
          if (capabilityStatus !== 'OK' || !idleSupported) return stop(failure('IDLE_UNSUPPORTED'));
          command('EXAMINE INBOX', selectStatus => {
            if (selectStatus !== 'OK') return stop(failure('UNAVAILABLE'));
            selected = true;
            idle();
          });
        });
        pending.capability = line => { idleSupported ||= /^\* CAPABILITY .*\bIDLE\b/i.test(line); };
      }, () => {
        if (item.provider !== 'microsoft' || ++challenges > 2) return stop(failure('AUTH_REJECTED'));
        const token = challenges === 1
          ? Buffer.from(`user=${item.email}\x01auth=Bearer ${item.accessToken}\x01\x01`).toString('base64') : '';
        socket.write(token + '\r\n');
      });
    }
    function changed() { if (ready && !stopped) onChange(); }
    function lineReceived(line) {
      if (/^\* BYE\b/i.test(line)) return stop(failure('UNAVAILABLE'));
      if (!announced) {
        if (!/^\* OK\b/i.test(line)) return stop(failure('UNAVAILABLE'));
        announced = true;
        return authenticate();
      }
      pending?.capability?.(line);
      const count = /^\* (\d+) EXISTS\b/i.exec(line);
      if (count) {
        if (selected && exists !== undefined && exists !== count[1]) changed();
        exists = count[1];
      }
      if (selected && /^\* \d+ EXPUNGE\b/i.test(line)) {
        if (exists !== undefined) exists = String(Math.max(0, Number(exists) - 1));
        changed();
      }
      for (const [name, previous] of [['UIDNEXT', uidNext], ['UIDVALIDITY', uidValidity]]) {
        const match = new RegExp('\\[' + name + ' (\\d+)\\]', 'i').exec(line);
        if (!match) continue;
        if (selected && previous !== undefined && previous !== match[1]) changed();
        if (name === 'UIDNEXT') uidNext = match[1]; else uidValidity = match[1];
      }
      if (line.startsWith('+')) return pending?.continuation?.();
      if (pending && line.startsWith(pending.tag + ' ')) {
        const current = pending;
        pending = undefined;
        cancel(deadline);
        current.done(line.split(' ', 3)[1].toUpperCase());
      }
    }
    try {
      socket = connectTls({ host, port: 993, servername: host, rejectUnauthorized: true });
      signal?.addEventListener('abort', abort, { once: true });
      armDeadline();
      socket.setEncoding('utf8');
      socket.on('data', chunk => {
        if (stopped) return;
        buffer += chunk;
        if (buffer.length > 65536) return stop(failure('UNAVAILABLE'));
        let end;
        while (!stopped && (end = buffer.indexOf('\r\n')) !== -1) {
          const line = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          lineReceived(line);
        }
      });
      socket.on('error', () => stop(failure('UNAVAILABLE')));
      socket.on('close', () => stop(failure('UNAVAILABLE')));
    } catch { stop(failure('UNAVAILABLE')); }
  });
}

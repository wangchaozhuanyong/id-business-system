"""Synthetic HTTP, TLS and DNS fixtures for the isolated network lab."""
import http.client
import http.server
import pathlib
import socket
import socketserver
import ssl
import struct
import sys
import threading


class Page(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        marker = f"fixture-{self.connection.getsockname()[0]}-{self.server.server_port}"
        self.send_response(200)
        self.send_header("Content-Type", "text/html")
        self.end_headers()
        self.wfile.write(f"<p>{marker}</p>".encode())

    def log_message(self, *_):
        pass


class NameServer(socketserver.BaseRequestHandler):
    def handle(self):
        packet, channel = self.request
        end = packet.index(b"\0", 12) + 1
        question = packet[12:end + 4]
        records = {b"\x03web\x04test\0": "203.0.113.10", b"\x06inside\x04test\0": "10.27.0.5"}
        address = records.get(packet[12:end])
        answer = b""
        if address and packet[end:end + 4] == b"\0\1\0\1":
            answer = b"\xc0\x0c" + struct.pack("!HHIH", 1, 1, 5, 4) + socket.inet_aton(address)
        header = packet[:2] + struct.pack("!5H", 0x8180 if address else 0x8183, 1, int(bool(answer)), 0, 0)
        channel.sendto(header + question + answer, self.client_address)


def serve(role, directory):
    class IPv6Server(http.server.ThreadingHTTPServer):
        address_family = socket.AF_INET6

    services = [http.server.ThreadingHTTPServer(("0.0.0.0", 80), Page)]
    if role == "router":
        services.append(IPv6Server(("fd00:ec2::254", 80), Page))
    if role == "web":
        tls = http.server.ThreadingHTTPServer(("203.0.113.10", 443), Page)
        cert = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        cert.load_cert_chain(directory / "cert.pem", directory / "key.pem")
        tls.socket = cert.wrap_socket(tls.socket, server_side=True)
        services.extend([tls, http.server.ThreadingHTTPServer(("203.0.113.10", 8080), Page),
                         socketserver.UDPServer(("203.0.113.53", 53), NameServer)])
    for service in services[1:]:
        threading.Thread(target=service.serve_forever, daemon=True).start()
    services[0].serve_forever()


def verify(role, phase, cert):
    alpha = role == "alpha"
    targets = [
        ("web-address", "203.0.113.10", 80, None, True),
        ("http", "web.test", 80, "203.0.113.10", True),
        ("https", "web.test", 443, "203.0.113.10", True),
        ("host", "192.0.2.1" if alpha else "192.0.2.5", 80, None, False),
        ("metadata", "169.254.169.254", 80, None, False),
        ("private-by-name", "inside.test", 80, "10.27.0.5", False),
        ("peer", "192.0.2.6" if alpha else "192.0.2.2", 80, None, False),
        ("non-web-port", "203.0.113.10", 8080, None, False),
        ("ipv6-metadata", "fd00:ec2::254", 80, None, False),
    ]
    for label, dest, port, ip, permitted in targets:
        connection = (http.client.HTTPSConnection(dest, port, timeout=2, context=ssl.create_default_context(cafile=cert))
                      if label == "https" else http.client.HTTPConnection(dest, port, timeout=2))
        try:
            connection.request("GET", "/")
            response = connection.getresponse()
            assert response.status == 200
            assert response.read() == f"<p>fixture-{ip or dest}-{port}</p>".encode()
            reachable = True
        except OSError as error:
            reachable = False
            if phase == "baseline" or permitted:
                raise AssertionError(f"{role}/{phase}/{label} did not reach its fixture") from error
        finally:
            connection.close()
        expected = phase == "baseline" or permitted
        if reachable != expected:
            raise AssertionError(f"{role}/{phase}/{label}: expected reachable={expected}, actual={reachable}")
        print(f"{role} {phase} {label}: {'reached' if reachable else 'blocked'}", flush=True)
    if phase == "enforced":
        assert socket.gethostbyname("inside.test") == "10.27.0.5"
        for interface in ("all", "default", "lo", "eth0"):
            path = pathlib.Path("/proc/sys/net/ipv6/conf") / interface / "disable_ipv6"
            assert path.read_text().strip() == "1"


if sys.argv[1] == "serve":
    serve(sys.argv[2], pathlib.Path(sys.argv[3]))
elif sys.argv[1] == "verify":
    verify(*sys.argv[2:])

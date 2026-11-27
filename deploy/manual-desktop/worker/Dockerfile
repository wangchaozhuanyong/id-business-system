FROM debian:trixie-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates chromium chromium-sandbox fonts-noto-cjk \
      matchbox-window-manager python3 tigervnc-standalone-server \
      tini x11-utils xauth \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd --gid 10001 workspace \
 && useradd --uid 10001 --gid 10001 --no-create-home --home-dir /profile \
      --shell /usr/sbin/nologin workspace \
 && install -d -m 0700 -o workspace -g workspace /profile /run/workspace

COPY worker.py recharge_proxy.py /usr/local/lib/manual-desktop/
USER 10001:10001
RUN /usr/bin/python3 -IB -c 'import runpy; runpy.run_path("/usr/local/lib/manual-desktop/worker.py")'
STOPSIGNAL SIGTERM
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/bin/python3", "-I", "-B", "/usr/local/lib/manual-desktop/worker.py"]

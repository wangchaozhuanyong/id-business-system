# Keep the deployed Node runtime pinned; Python is required by mailbox-imap.py.
FROM node@sha256:e1582112fb9f152ed38eefcd712efc93fee1becb519fdfa57574d5e07eaa5e7d
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && python3 -B -c "import email, imaplib, json, ssl; assert ssl.create_default_context().cert_store_stats()['x509_ca'] > 0"

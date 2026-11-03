#!/bin/sh
set -eu
domain=chess-api.agent.soft-magic.com
case "${RENEWED_DOMAINS:-}" in *"$domain"*) ;; *) exit 0 ;; esac
install -m 600 "/etc/letsencrypt/live/$domain/fullchain.pem" /etc/kamkmchess-tls/fullchain.pem.new
install -m 600 "/etc/letsencrypt/live/$domain/privkey.pem" /etc/kamkmchess-tls/privkey.pem.new
mv -f /etc/kamkmchess-tls/fullchain.pem.new /etc/kamkmchess-tls/fullchain.pem
mv -f /etc/kamkmchess-tls/privkey.pem.new /etc/kamkmchess-tls/privkey.pem
nginx -t
systemctl reload nginx

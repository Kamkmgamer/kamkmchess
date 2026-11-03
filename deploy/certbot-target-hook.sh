#!/bin/sh
set -eu
legacy=chess-api.agent.soft-magic.com
current=api.chess.khalil.mageed.net
case "${RENEWED_DOMAINS:-}" in
  *"$legacy"*)
    install -m 600 "/etc/letsencrypt/live/$legacy/fullchain.pem" /etc/kamkmchess-tls/fullchain.pem.new
    install -m 600 "/etc/letsencrypt/live/$legacy/privkey.pem" /etc/kamkmchess-tls/privkey.pem.new
    mv -f /etc/kamkmchess-tls/fullchain.pem.new /etc/kamkmchess-tls/fullchain.pem
    mv -f /etc/kamkmchess-tls/privkey.pem.new /etc/kamkmchess-tls/privkey.pem ;;
  *"$current"*) ;;
  *) exit 0 ;;
esac
nginx -t
systemctl reload nginx

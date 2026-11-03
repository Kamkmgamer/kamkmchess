#!/bin/sh
set -eu
domain=chess-api.agent.soft-magic.com
if [ ! -f "/etc/letsencrypt/live/$domain/fullchain.pem" ]; then
  certbot certonly --webroot -w /var/www/kamkmchess-acme -d "$domain" --agree-tos --register-unsafely-without-email --non-interactive
fi
if ! cmp -s "/etc/letsencrypt/live/$domain/fullchain.pem" /etc/kamkmchess-tls/fullchain.pem ||
   ! cmp -s "/etc/letsencrypt/live/$domain/privkey.pem" /etc/kamkmchess-tls/privkey.pem; then
  RENEWED_DOMAINS="$domain" /etc/letsencrypt/renewal-hooks/deploy/kamkmchess.sh
fi
certbot renew --quiet

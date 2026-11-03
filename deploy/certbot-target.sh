#!/bin/sh
set -eu
domain=chess-api.agent.soft-magic.com
if [ ! -f "/etc/letsencrypt/live/$domain/fullchain.pem" ]; then
  certbot certonly --webroot -w /var/www/kamkmchess-acme -d "$domain" --agree-tos --register-unsafely-without-email --non-interactive
fi
certbot renew --quiet

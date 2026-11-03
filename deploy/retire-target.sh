#!/bin/bash
set -Eeuo pipefail
root=/opt/kamkmchess/server
deadline=$root/.retire-not-before
[ -f "$deadline" ] || exit 0
[ "$(date -u +%s)" -ge "$(cat "$deadline")" ] || exit 0
test -f "$root/.target-cutover-complete"
domain=api.chess.khalil.mageed.net
test -f "/etc/letsencrypt/live/$domain/fullchain.pem"
openssl x509 -in "/etc/letsencrypt/live/$domain/fullchain.pem" -noout -checkend 604800 >/dev/null
getent ahostsv4 "$domain" | awk '{print $1}' | grep -qx 104.204.68.77
test "$(curl -sS -o /dev/null -w '%{http_code}' --resolve "$domain:443:104.204.68.77" "https://$domain/v1/online/features")" = 200
test "$(docker inspect -f '{{.State.Health.Status}}' kamkmchess-api-1)" = healthy
test "$(docker inspect -f '{{.State.Health.Status}}' kamkmchess-postgres-1)" = healthy
ssh -i /opt/kamkmchess/migration/id_ed25519 -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=/opt/kamkmchess/tunnel/known_hosts -p 9004 agentsoftmagic@mageed.net retire
systemctl disable --now kamkmchess-tunnel.service
systemctl disable --now kamkmchess-retire.timer
rm -f "$deadline"

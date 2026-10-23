# The API image carries the private rules runtime.
#
# It is the pinned Node 24 runtime plus the bundled rules worker, which the Go
# match authority runs as a child process. The worker has no public endpoint,
# no provider access and no database access. The bundle is private server
# code: it is never part of the public browser distribution in dist/.
FROM node:24.22.0-alpine
RUN apk add --no-cache ca-certificates curl
# The native Stockfish of the optional server engine seat. It is left out
# unless the image is built with --build-arg WITH_SERVER_ENGINE=1, so the
# default image is unchanged. Alpine ships Stockfish only in its edge
# repository.
ARG WITH_SERVER_ENGINE=0
RUN if [ "$WITH_SERVER_ENGINE" = "1" ]; then \
      apk add --no-cache stockfish --repository=https://dl-cdn.alpinelinux.org/alpine/edge/community --repository=https://dl-cdn.alpinelinux.org/alpine/edge/testing; \
    fi
COPY bin/kamkmchess-api /usr/local/bin/kamkmchess-api
COPY rules-worker/worker.mjs /opt/kamkmchess/rules-worker/worker.mjs
COPY rules-worker/LICENSE.txt /opt/kamkmchess/rules-worker/LICENSE.txt
COPY rules-worker/THIRD_PARTY_NOTICES.txt /opt/kamkmchess/rules-worker/THIRD_PARTY_NOTICES.txt
# The entry point of the private rules process. The API reads it from the
# environment, so the composition cannot start without the bundle.
ENV ONLINE_RULES_WORKER_ENTRY=/opt/kamkmchess/rules-worker/worker.mjs
ENV NODE_ENV=production
USER 65532:65532
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/kamkmchess-api"]

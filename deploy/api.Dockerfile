FROM alpine:3.23
RUN apk add --no-cache ca-certificates curl
COPY bin/kamkmchess-api /usr/local/bin/kamkmchess-api
USER 65532:65532
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/kamkmchess-api"]

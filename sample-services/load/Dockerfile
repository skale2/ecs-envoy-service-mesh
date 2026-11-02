# Fortio (https://github.com/fortio/fortio), plus curl for the mesh's standard
# health check and jq for turning each load window into one log line. The
# upstream image has no shell, so the binary is copied onto Alpine.
FROM fortio/fortio:1.76.0 AS fortio

FROM public.ecr.aws/docker/library/alpine:3.22
RUN apk add --no-cache curl jq
COPY --from=fortio /usr/bin/fortio /usr/bin/fortio
COPY entrypoint.sh /entrypoint.sh
EXPOSE 8080
ENTRYPOINT ["/entrypoint.sh"]

FROM public.ecr.aws/docker/library/golang:1.27-alpine AS build
WORKDIR /src
COPY go.mod main.go ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /demo .

FROM public.ecr.aws/docker/library/alpine:3.22
# curl for the mesh's standard health check (curl /health).
RUN apk add --no-cache curl
COPY --from=build /demo /usr/local/bin/demo
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/demo"]

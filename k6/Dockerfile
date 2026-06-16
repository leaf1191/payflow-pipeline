FROM golang:1.23-alpine AS builder

RUN apk add --no-cache git \
    && go install go.k6.io/xk6/cmd/xk6@latest \
    && xk6 build \
        --with github.com/grafana/xk6-sql@latest \
        --with github.com/grafana/xk6-sql-driver-postgres@latest \
        --output /k6

FROM alpine:3.21

RUN apk add --no-cache ca-certificates

COPY --from=builder /k6 /usr/local/bin/k6

WORKDIR /scripts
ENTRYPOINT ["k6"]

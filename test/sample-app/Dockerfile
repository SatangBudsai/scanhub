# Intentionally insecure sample used to test ScanHub: runs as root, no healthcheck, latest tag
FROM golang:latest
ADD . /app
WORKDIR /app
RUN go build -o /payment-api ./...
EXPOSE 8080
CMD ["/payment-api"]

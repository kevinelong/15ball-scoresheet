#!/bin/sh
# Build the static 15-Ball server binary (pure-Go SQLite, no CGo) for linux/amd64.
# Output: server/bin/fifteenball-server. Run from anywhere; resolves its own dir.
set -eu
here=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$here"
mkdir -p bin
echo "go test ./..."
go test ./... || { echo "tests failed"; exit 1; }
echo "building bin/fifteenball-server (CGO_ENABLED=0 linux/amd64)…"
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -o bin/fifteenball-server ./cmd/fifteenball-server
echo "built: $(ls -la bin/fifteenball-server)"

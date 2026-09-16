.DEFAULT_GOAL := build

GO ?= go
GOFMT ?= gofmt
NODE ?= node
LDFLAGS ?= -s -w
ARGS ?=

.PHONY: build run test vet check check-js fmt linux linux-amd64 linux-arm64 clean help

build:
	mkdir -p bin
	$(GO) build -trimpath -ldflags="$(LDFLAGS)" -o bin/servmon ./src

run: build
	./bin/servmon $(ARGS)

test:
	$(GO) test -race ./...

vet:
	$(GO) vet ./...

check: test vet check-js

check-js:
	$(NODE) --check src/web/app.js
	$(NODE) --check src/web/theme.js
	$(NODE) --check src/web/sw.js

fmt:
	$(GOFMT) -w src

linux: linux-amd64 linux-arm64

linux-amd64:
	mkdir -p bin
	CGO_ENABLED=0 GOOS=linux GOARCH=amd64 $(GO) build -trimpath -ldflags="$(LDFLAGS)" -o bin/servmon-linux-amd64 ./src

linux-arm64:
	mkdir -p bin
	CGO_ENABLED=0 GOOS=linux GOARCH=arm64 $(GO) build -trimpath -ldflags="$(LDFLAGS)" -o bin/servmon-linux-arm64 ./src

# Only remove known build outputs; keep configuration and monitoring data.
clean:
	rm -f bin/servmon bin/servmon-linux-amd64 bin/servmon-linux-arm64

help:
	@printf '%s\n' \
	  'make / make build  Build bin/servmon for the current platform' \
	  'make run ARGS="..." Build and run from the project root' \
	  'make test          Run Go tests with the race detector' \
	  'make vet           Run go vet' \
	  'make check         Run tests, vet and JavaScript syntax checks' \
	  'make fmt           Format Go source files' \
	  'make linux         Build Linux amd64 and arm64 binaries' \
	  'make linux-amd64   Build only the Linux amd64 binary' \
	  'make linux-arm64   Build only the Linux arm64 binary' \
	  'make clean         Remove the three known binaries from bin/'

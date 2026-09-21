.DEFAULT_GOAL := build

GO ?= go
GOFMT ?= gofmt
NODE ?= node
LDFLAGS ?= -s -w
ARGS ?=

.PHONY: build run test vet check check-js test-web check-install test-install fmt release linux linux-amd64 linux-arm64 darwin darwin-amd64 darwin-arm64 clean help

build:
	mkdir -p bin
	$(GO) build -trimpath -ldflags="$(LDFLAGS)" -o bin/servmon ./src

run: build
	./bin/servmon $(ARGS)

test:
	$(GO) test -race ./...

vet:
	$(GO) vet ./...

check: test vet check-js test-web check-install

check-js:
	$(NODE) --check src/web/app.js
	$(NODE) --check src/web/i18n.js
	$(NODE) --check src/web/layout.js
	$(NODE) --check src/web/theme.js
	$(NODE) --check src/web/sw.js

test-web:
	$(NODE) --test tests/*.test.cjs

check-install:
	bash -n install.sh tests/install.test.sh

# Writes only inside a disposable container; source checkout is read-only.
test-install: release check-install
	docker run --rm --network none -v "$(CURDIR):/work:ro" --entrypoint bash node:22-bookworm-slim /work/tests/install.test.sh

fmt:
	$(GOFMT) -w src

linux: linux-amd64 linux-arm64

darwin: darwin-amd64 darwin-arm64

release: linux darwin

linux-amd64 linux-arm64 darwin-amd64 darwin-arm64:
	mkdir -p bin
	CGO_ENABLED=0 GOOS=$(word 1,$(subst -, ,$@)) GOARCH=$(word 2,$(subst -, ,$@)) $(GO) build -trimpath -ldflags="$(LDFLAGS)" -o bin/servmon-$@ ./src

# Only remove known build outputs; keep configuration and monitoring data.
clean:
	rm -f bin/servmon bin/servmon-linux-amd64 bin/servmon-linux-arm64 bin/servmon-darwin-amd64 bin/servmon-darwin-arm64

help:
	@printf '%s\n' \
	  'make / make build  Build bin/servmon for the current platform' \
	  'make run ARGS="..." Build and run from the project root' \
	  'make test          Run Go tests with the race detector' \
	  'make vet           Run go vet' \
	  'make check         Run Go/JS tests, vet and syntax checks' \
	  'make test-web      Run localization and layout tests' \
	  'make check-install Check installer shell syntax' \
	  'make test-install  Test installation in a disposable Docker container' \
	  'make fmt           Format Go source files' \
	  'make linux         Build Linux amd64 and arm64 binaries' \
	  'make linux-amd64   Build only the Linux amd64 binary' \
	  'make linux-arm64   Build only the Linux arm64 binary' \
	  'make darwin        Build macOS amd64 and arm64 binaries' \
	  'make release       Build all four release binaries' \
	  'make clean         Remove known binaries from bin/'

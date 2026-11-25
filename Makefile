# Local development. Go runs in Docker, so nothing but Docker and Node is needed.
GO = docker run --rm -u $$(id -u):$$(id -g) -e HOME=/tmp -e GOCACHE=/tmp/.cache -e GOMODCACHE=/tmp/mod \
	-v quire-gomod:/tmp/mod -v quire-gocache:/tmp/.cache -v $(CURDIR)/backend:/src -w /src -e CGO_ENABLED=0 golang:1.27-alpine

.PHONY: web build test run dev image

web:
	cd frontend && npm run build
	rm -rf backend/internal/webui/dist && mkdir -p backend/internal/webui/dist
	cp -r frontend/dist/. backend/internal/webui/dist/ && touch backend/internal/webui/dist/.keep

build: web
	$(GO) go build -o bin/quire ./cmd/quire

test:
	$(GO) go test ./...

# Serves the built app on this machine only (127.0.0.1:8196) with a local vault in ./notes.
run: build
	QUIRE_PASSWORD=$${QUIRE_PASSWORD:-quire-local-dev} QUIRE_LISTEN=127.0.0.1:8196 QUIRE_NOTES_DIR=./notes QUIRE_DATA_DIR=./data backend/bin/quire

# Vite with hot reload on :5173, proxying /api to `make run`.
dev:
	cd frontend && npm run dev

image:
	docker build -t quire:dev .

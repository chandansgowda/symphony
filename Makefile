.PHONY: build build-ui run dev prod service-stop service-restart service-status service-logs clean typecheck

build:
	npm run build

build-ui:
	npm run build:ui

run: build
	node dist/cli.js --watch

dev: build-ui
	bash scripts/service.sh restart --dev

prod: build
	bash scripts/service.sh restart

service-stop:
	bash scripts/service.sh stop

service-restart:
	bash scripts/service.sh restart

service-restart-dev:
	bash scripts/service.sh restart --dev

service-status:
	bash scripts/service.sh status

service-logs:
	bash scripts/service.sh logs

typecheck:
	npm run typecheck

clean:
	rm -rf dist node_modules

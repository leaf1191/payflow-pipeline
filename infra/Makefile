.PHONY: up down logs build connectors ps

# S3 적재 완료 후 Airflow 기동: make down && cd airflow && make up

up: build
	docker compose --env-file .env up -d
	@echo "Run 'make connectors' if connector-setup did not finish successfully."

down:
	docker compose --env-file .env down

logs:
	docker compose --env-file .env logs -f

build:
	docker compose --env-file .env build

connectors:
	docker compose --env-file .env up connector-setup

ps:
	docker compose --env-file .env ps

.PHONY: up down logs build ps init

build:
	docker compose --env-file .env build

init: build
	docker compose --env-file .env up airflow-init

up: build
	docker compose --env-file .env up airflow-init
	docker compose --env-file .env up -d

down:
	docker compose --env-file .env down

logs:
	docker compose --env-file .env logs -f

ps:
	docker compose --env-file .env ps

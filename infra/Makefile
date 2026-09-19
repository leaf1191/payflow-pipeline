.PHONY: up down logs build connectors ps

# ALO / EOS 비교. 힙·parquet·flush 는 공유 .env 와 동일 커넥터 설정을 쓴다.
# 동시에 띄우지 말 것 (호스트 포트가 같다).
#   make up            # ALO (기본)
#   make up MODE=eos
#   make down MODE=eos

MODE ?= alo
COMPOSE := docker compose --env-file .env \
	-f $(MODE)/docker-compose.yml \
	-f monitoring/docker-compose.metrics.yml

ifneq ($(filter $(MODE),alo eos),$(MODE))
$(error MODE must be alo or eos, got '$(MODE)')
endif

# S3 적재 완료 후 Airflow 기동: make down && cd airflow && make up
# 메트릭: postgres-exporter :9187, kafka jmx :7071, debezium jmx :7072,
#         connect-s3 jmx :7073, kafka-exporter :9308
# 로컬 scrape: ../../local/monitoring (SCRAPE_HOST=이 EC2 IP)

up: build
	$(COMPOSE) up -d
	@echo "Started $(MODE). Run 'make connectors MODE=$(MODE)' if connector-setup did not finish successfully."
	@echo "Metrics: :9187 :7071 :7072 :7073 :9308 (pipeline=$(MODE))"

down:
	$(COMPOSE) down

logs:
	$(COMPOSE) logs -f

build:
	$(COMPOSE) build

connectors:
	$(COMPOSE) up connector-setup

ps:
	$(COMPOSE) ps

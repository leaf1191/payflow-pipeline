# EC2 인프라 메트릭 scrape 대상.
# __SCRAPE_HOST__ / __PIPELINE_MODE__ 는 compose entrypoint 가 .env 값으로 치환한다.

global:
  scrape_interval: 15s
  evaluation_interval: 15s
  external_labels:
    pipeline: __PIPELINE_MODE__

scrape_configs:
  - job_name: postgres
    static_configs:
      - targets: ["__SCRAPE_HOST__:9187"]
        labels:
          service: postgres
          pipeline: __PIPELINE_MODE__

  - job_name: kafka
    static_configs:
      - targets: ["__SCRAPE_HOST__:7071"]
        labels:
          service: kafka
          pipeline: __PIPELINE_MODE__

  - job_name: connect-cdc
    # Debezium Connect worker (JMX: GC pause, source task metrics)
    static_configs:
      - targets: ["__SCRAPE_HOST__:7072"]
        labels:
          service: connect-cdc
          pipeline: __PIPELINE_MODE__

  - job_name: connect-s3
    # S3 Sink Connect worker (JMX: GC pause, sink task metrics)
    static_configs:
      - targets: ["__SCRAPE_HOST__:7073"]
        labels:
          service: connect-s3
          pipeline: __PIPELINE_MODE__

  - job_name: kafka-exporter
    # Consumer lag (백프레셔 검증 핵심)
    static_configs:
      - targets: ["__SCRAPE_HOST__:9308"]
        labels:
          service: kafka-exporter
          pipeline: __PIPELINE_MODE__

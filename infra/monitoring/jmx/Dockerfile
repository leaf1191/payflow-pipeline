# Shared JMX Prometheus javaagent + scrape rule YAMLs for Kafka / Connect.
# Copied into a named volume by jmx-agent-init before JVM services start.
FROM curlimages/curl:8.11.1 AS download

ARG JMX_EXPORTER_VERSION=1.0.1
WORKDIR /jmx

RUN curl -fsSL -o jmx_prometheus_javaagent.jar \
  "https://repo1.maven.org/maven2/io/prometheus/jmx/jmx_prometheus_javaagent/${JMX_EXPORTER_VERSION}/jmx_prometheus_javaagent-${JMX_EXPORTER_VERSION}.jar"

FROM busybox:1.36

COPY --from=download /jmx/jmx_prometheus_javaagent.jar /jmx/jmx_prometheus_javaagent.jar
COPY kafka-broker.yml /jmx/kafka-broker.yml
COPY kafka-connect.yml /jmx/kafka-connect.yml

# Init container: docker compose runs `cp -a /jmx/. /jmx-out/`
CMD ["cp", "-a", "/jmx/.", "/jmx-out/"]

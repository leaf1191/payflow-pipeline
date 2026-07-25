FROM apache/airflow:2.10.5-python3.12

USER airflow

RUN pip install --no-cache-dir \
    apache-airflow-providers-amazon==9.1.0 \
    apache-airflow-providers-snowflake==5.8.0 \
    apache-airflow-providers-slack==8.9.1

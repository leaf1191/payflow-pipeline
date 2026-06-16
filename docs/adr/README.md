# Architecture Decision Records (ADR)

이 디렉터리는 프로젝트의 **중요한 기술·아키텍처 결정**을 기록합니다.

## 왜 ADR을 쓰나

- **맥락 보존**: "왜 이렇게 했는지"를 코드와 함께 남깁니다.
- **재논의 비용 절감**: 같은 주제를 반복 논의하지 않도록 합니다.
- **변경 추적**: 결정이 바뀔 때 Superseded 링크로 이력을 이어갑니다.

## 파일 규칙

| 항목 | 규칙 |
| --- | --- |
| 위치 | `docs/adr/` |
| 이름 | `NNNN-kebab-case-title.md` (예: `0003-use-snowflake-elt-instead-of-athena.md`) |
| 번호 | 4자리, 순차 증가. 한 번 발행한 번호는 재사용하지 않습니다. |
| 언어 | 본문은 한국어. 기술 용어·제품명은 영문 그대로 사용 |

## 상태 (Status)

| 상태 | 의미 |
| --- | --- |
| `Proposed` | 논의 중, 아직 확정 전 |
| `Accepted` | 채택됨, 현재 유효 |
| `Deprecated` | 더 이상 권장하지 않음 |
| `Superseded` | 다른 ADR로 대체됨 (`Superseded by` 링크 필수) |

## 새 ADR 작성 절차

1. `template.md`를 복사해 다음 번호로 파일 생성
2. `Context`에 문제·제약·대안을 충분히 기술
3. `Decision`은 한 문장으로 명확히
4. PR에 ADR을 포함하고, 관련 코드/인프라 변경과 함께 리뷰
5. 채택 시 Status를 `Accepted`로 변경

## 인덱스

| ADR | 제목 | 상태 |
| --- | --- | --- |
| [0001](0001-record-architecture-decisions.md) | ADR로 아키텍처 결정 기록 | Accepted |
| [0002](0002-adopt-cdc-with-debezium-for-ingestion.md) | 수집 레이어에 CDC(Debezium) 채택 | Accepted |
| [0003](0003-use-snowflake-elt-instead-of-s3-athena-dq.md) | DQ·변환을 Snowflake ELT로 통합 | Accepted |

## 참고

- [Documenting Architecture Decisions (Michael Nygard)](https://cognitect.com/blog/2011/11/15/documenting-architecture-decisions)
- [adr-tools](https://github.com/npryce/adr-tools) — CLI로 ADR 생성·관리 (선택)

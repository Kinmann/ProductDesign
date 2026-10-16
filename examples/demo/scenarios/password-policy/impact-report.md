<!-- specflow impact로 만든 예시 결과 (변경 전 DEMO를 반영하고 links.yaml을 등록한 뒤, 이 시나리오를 미리보기로 분석). 기대값의 원본은 expected.yaml이다. -->

## Impact Report · DEMO CS-0002 (미리보기)

### 변경 요소 3개

| 요소 | 변경 | 유형 | 버전 |
|---|---|---|---|
| `AC-SIGNUP-002-01` | 수정 | Behavioral | v1 → v2 |
| `AC-SIGNUP-002-04` | 신규 | Behavioral | 신규 v1 |
| `RULE-PW-001` | 수정 | Rule | v1 → v2 |

### 예상 영향

| 도메인 | High | Medium | Low | 신규 작업 |
|---|---|---|---|---|
| 디자인 | 2 | 1 | 0 | 0 |
| 개발 | 2 | 0 | 0 | 0 |
| QA | 1 | 2 | 0 | 1 |

### 디자인

| 등급 | 산출물 | 작업 | 근거 경로 |
|---|---|---|---|
| High | `DSN-LOGIN-MAIN` 로그인 | 수정 | RULE-PW-001 ←GOVERNED_BY─ REQ-LOGIN-001 ←IMPLEMENTS─ DSN-LOGIN-MAIN |
| High | `DSN-SIGNUP-PW` 회원가입 비밀번호 입력 | 수정 | RULE-PW-001 ←GOVERNED_BY─ REQ-SIGNUP-002 ←IMPLEMENTS─ DSN-SIGNUP-PW |
| Medium | `DSN-ACCOUNT-PWCHANGE` 비밀번호 변경 | 수정 | RULE-PW-001 ←GOVERNED_BY─ REQ-ACCOUNT-004 ─APPEARS_ON→ SCR-ACCOUNT-PW ←IMPLEMENTS─ DSN-ACCOUNT-PWCHANGE |

### 개발

| 등급 | 산출물 | 작업 | 근거 경로 |
|---|---|---|---|
| High | `CODE-auth/login` 로그인 처리 모듈 | 수정 | RULE-PW-001 ←GOVERNED_BY─ REQ-LOGIN-001 ←REALIZES─ CODE-auth/login |
| High | `CODE-auth/password-validator` 비밀번호 검증 모듈 | 수정 | RULE-PW-001 ←GOVERNED_BY─ REQ-SIGNUP-002 ←REALIZES─ CODE-auth/password-validator |

### QA

| 등급 | 산출물 | 작업 | 근거 경로 |
|---|---|---|---|
| High | `TC-SIGNUP-007` 비밀번호 최소 길이 미만 입력 시 에러 | 수정 | AC-SIGNUP-002-01 ←VERIFIES─ TC-SIGNUP-007 |
| Medium | `TC-ACCOUNT-012` 비밀번호 변경 시 정책 검증 | 수정 | RULE-PW-001 ←GOVERNED_BY─ REQ-ACCOUNT-004 ─HAS_CRITERIA→ AC-ACCOUNT-004-02 ←VERIFIES─ TC-ACCOUNT-012 |
| Medium | `TC-LOGIN-020` 기존 회원 로그인 성공 | 수정 | RULE-PW-001 ←GOVERNED_BY─ REQ-LOGIN-001 ─HAS_CRITERIA→ AC-LOGIN-001-01 ←VERIFIES─ TC-LOGIN-020 |

### 신규 작업

| 도메인 | 기획 요소 | 등급 | 이유 |
|---|---|---|---|
| QA | `AC-SIGNUP-002-04` | High | 새 기획 요소 |

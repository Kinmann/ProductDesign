# DEMO 파일럿 프로젝트

기획서([PRD_ai-native-pipeline.md](../../PRD_ai-native-pipeline.md))의 예시를 실제 파일로 옮긴 파일럿 프로젝트다. 프로젝트 키는 `DEMO`다.

| 경로 | 내용 |
|---|---|
| `specs/` | 변경 전 기획서. PRD(기능 3개, 비밀번호 정책), FDD(회원가입·로그인·계정 관리), IA(사이트맵, 화면 6개), 용어집 |
| `links.yaml` | 디자인·개발·QA 산출물 8건과 기획 요소의 연결. 실제 운영에서는 도메인 에이전트가 등록하는 정보를 대신한다 |
| `scenarios/password-policy/` | 기획서 8.4 "비밀번호 정책 변경" 시나리오. `specs/`에 덮어쓸 변경 후 파일과 기대 결과(`expected.yaml`) |

## 시나리오: 비밀번호 정책 변경

1. **정책만 변경**: `scenarios/password-policy/specs/prd/policies/password.md`를 덮어쓴다. 최소 길이가 8자에서 10자로, 필수 문자에 특수문자가 추가된다. FDD의 인수 조건은 아직 "8자"라서 린트가 L14와 L09로 막아야 한다.
2. **연쇄 수정 반영**: `scenarios/password-policy/specs/fdd/signup.md`도 덮어쓴다. 인수 조건이 10자로 바뀌고 특수문자 조건(`AC-SIGNUP-002-04`)이 추가된다.
3. **영향도 분석**: 기획서 8.4 ③ 표와 같이 산출물 8건(디자인 3, 개발 2, QA 3)과 신규 작업 1건이 나와야 한다.

## 그래프가 시나리오 결과와 맞도록 둔 제약

영향도 분석은 정책에서 최대 3단계까지 퍼진다. 그래서 그 범위 안의 다른 요소에는 산출물을 연결하지 않았다. 산출물을 추가하면 `expected.yaml`도 함께 고쳐야 한다.
- `REQ-ACCOUNT-001`은 `REQ-LOGIN-001`에 의존하므로 정책 변경 시 2단계에서 도달한다.
- `SCR-SIGNUP`, `SCR-LOGIN`, `FLOW-SIGNUP-01`, `REQ-SIGNUP-001`도 2~3단계에서 도달한다.

---
id: IA-SCR-SIGNUP
doc: ia
title: 회원가입 화면
owner: jisu.kim
status: approved
version: 1.1.0
---

### SCR-SIGNUP 회원가입
- 상위: [[SCR-HOME]]
- 요구사항: [[REQ-SIGNUP-001]], [[REQ-SIGNUP-002]]
- 플로우: [[FLOW-SIGNUP-01]]
- 이동: [[SCR-SIGNUP-DONE]] (가입 완료 시), [[SCR-LOGIN]] (이메일 중복 시)
- 구성: 이메일 입력, 비밀번호 입력, 비밀번호 확인, 가입 버튼

### SCR-SIGNUP-DONE 가입 완료
- 상위: [[SCR-SIGNUP]]
- 플로우: [[FLOW-SIGNUP-01]]
- 이동: [[SCR-HOME]]
- 구성: 환영 문구, 홈으로 가기 버튼

---
id: FDD-ACCOUNT
doc: fdd
feature: FEAT-ACCOUNT
title: 계정 관리 FDD
owner: jisu.kim
status: approved
version: 1.2.0
---

# 계정 관리 FDD

## 요구사항

### REQ-ACCOUNT-001 내 정보 보기
- 설명: 회원은 가입 때 입력한 이메일과 가입일을 본다.
- 데이터: [[DATA-USER]]
- 의존: [[REQ-LOGIN-001]], [[REQ-SIGNUP-001]]
- 인수 조건:
  - AC-ACCOUNT-001-01: 로그인하지 않은 상태로 접근하면 로그인 화면으로 이동한다.

### REQ-ACCOUNT-004 비밀번호 변경
- 설명: 회원은 현재 비밀번호를 확인한 뒤 새 비밀번호로 바꾼다.
- 정책: [[RULE-PW-001]]
- 인수 조건:
  - AC-ACCOUNT-004-01: 현재 비밀번호가 틀리면 "현재 비밀번호가 일치하지 않습니다"를 표시한다.
  - AC-ACCOUNT-004-02: 새 비밀번호가 정책에 맞지 않으면 에러를 표시한다.

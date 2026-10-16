---
id: FDD-LOGIN
doc: fdd
feature: FEAT-LOGIN
title: 로그인 FDD
owner: jisu.kim
status: approved
version: 1.1.0
---

# 로그인 FDD

## 요구사항

### REQ-LOGIN-001 이메일 로그인
- 설명: 회원은 이메일과 비밀번호로 로그인한다.
- 정책: [[RULE-PW-001]]
- 데이터: [[DATA-USER]]
- 인수 조건:
  - AC-LOGIN-001-01: 가입된 이메일과 올바른 비밀번호를 입력하면 홈 화면으로 이동한다.
  - AC-LOGIN-001-02: 이메일이나 비밀번호가 틀리면 "이메일 또는 비밀번호가 일치하지 않습니다"를 표시한다.

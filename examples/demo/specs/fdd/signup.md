---
id: FDD-SIGNUP
doc: fdd
feature: FEAT-SIGNUP
title: 회원가입 FDD
owner: jisu.kim
status: approved
version: 1.4.0
---

# 회원가입 FDD

## 요구사항

### REQ-SIGNUP-001 이메일 입력
- 설명: 방문자는 이메일을 입력하고 중복 여부를 확인한다.
- 데이터: [[DATA-USER]]
- 인수 조건:
  - AC-SIGNUP-001-01: 이미 가입된 이메일이면 "이미 사용 중인 이메일입니다"를 표시한다.
  - AC-SIGNUP-001-02: 이메일 형식이 아니면 "이메일 형식을 확인해주세요"를 표시한다.

### REQ-SIGNUP-002 비밀번호 설정
- 설명: 방문자는 정책에 맞는 비밀번호를 설정한다.
- 정책: [[RULE-PW-001]]
- 의존: [[REQ-SIGNUP-001]]
- 인수 조건:
  - AC-SIGNUP-002-01: 8자 미만이면 "8자 이상 입력해주세요"를 표시한다. (RULE-PW-001 최소 길이)
  - AC-SIGNUP-002-02: 비밀번호 확인 값이 다르면 가입 버튼을 비활성화한다.
  - AC-SIGNUP-002-03: 영문과 숫자가 모두 포함되지 않으면 안내 문구를 표시한다.

## 플로우

### FLOW-SIGNUP-01 이메일 가입
- 단계: [[REQ-SIGNUP-001]] → [[REQ-SIGNUP-002]]
- 예외: 이메일 중복 시 로그인 화면으로 안내

## 데이터

### DATA-USER 사용자
- 설명: 가입한 회원의 계정 정보
- 항목: 이메일, 비밀번호 해시, 가입일

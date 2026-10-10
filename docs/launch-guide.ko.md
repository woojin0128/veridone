# Veridone 운영 가이드 (판매자용)

> 판매자(당신)를 위한 운영 매뉴얼입니다. 사용자용 설명은 [README.ko.md](../README.ko.md)를 보세요.
> 결제 플랫폼 정책과 수수료는 2026년 9~10월 기준으로 조사한 내용이라 바뀔 수 있습니다. 가입할 때 각 사이트에서 다시 확인하세요.

## 0. 지금 상태

| 항목 | 상태 |
|---|---|
| 저장소 | https://github.com/woojin0128/veridone (공개) |
| 웹사이트 | https://woojin0128.github.io/veridone/ (한국어: `/ko/`) — 가격표, 약관, 개인정보 처리방침, 환불 정책, 활성화 안내 포함 |
| 설치 | Claude Code에서 `/plugin marketplace add woojin0128/veridone` → `/plugin install veridone@veridone` |
| GitHub Action | `uses: woojin0128/veridone@v1` |
| 자동화 | 테스트(CI), 버전을 올리면 자동 릴리스(Release), 사이트 자동 배포(Website), 스토어 연결(Connect store) |
| 수익 구조 | 무료 + 14일 무료 체험 → Pro(월 $9 / 연 $79) · Team(좌석당 연 $190, 2석부터) · Founder 평생권($149, 런칭 한정) |
| 남은 일 | **Polar 계정 연결 (아래 1단계, 본인만 할 수 있음)** |

결제 연결 전까지 웹사이트 가격표에는 "유료 플랜은 곧 열립니다"와 무료 체험 안내가 나옵니다. 연결이 끝나면 결제 버튼이 자동으로 켜집니다.

---

## 1. 결제 연결 (20분, 한 번만)

Polar는 판매 대행(Merchant of Record) 플랫폼입니다. 법적 판매자가 Polar가 되어 전 세계 부가세·판매세를 대신 걷고 신고하므로, 1인 사업자도 해외에 소프트웨어를 팔 수 있습니다. 한국은 정산 지원 국가에 포함돼 있습니다. 라이선스 키 발급·이메일 발송·환불 시 자동 해지까지 Polar가 처리하므로 별도 서버가 필요 없습니다.

### 1-1. Polar 가입과 조직 만들기

1. https://polar.sh 에서 가입합니다(GitHub 계정으로 로그인 가능).
2. 조직(Organization)을 만듭니다. 이름 `Veridone`, 주소(slug) `veridone`을 추천합니다. slug는 고객 포털 주소(`polar.sh/<slug>/portal`)에 쓰입니다.
3. 조직 설정에 웹사이트 `https://woojin0128.github.io/veridone/`와 지원용 이메일을 넣습니다. Polar가 계정을 검토할 때 사이트의 가격표·약관·환불 정책을 봅니다(이미 준비돼 있음).
4. 정산(Payouts) 메뉴에서 본인 인증과 정산 계좌를 연결합니다. Stripe 화면이 나오면 안내대로 개인사업자 정보와 한국 계좌를 입력하세요.

### 1-2. 토큰 만들기

Polar → Settings → Developers → **New token**

- 이름: `veridone-store-setup`
- 만료: 30일이면 충분합니다(스토어 설정 후에는 필요 없음).
- 권한(Scopes): `organizations:read`, `products:read`, `products:write`, `benefits:read`, `benefits:write`, `checkout_links:read`, `checkout_links:write`

생성된 토큰(`polar_oat_…`)을 복사합니다. 이 토큰은 채팅이나 이슈에 붙여 넣지 마세요.

### 1-3. GitHub에 토큰 넣고 버튼 누르기

1. https://github.com/woojin0128/veridone/settings/secrets/actions → **New repository secret**
   - Name: `POLAR_ACCESS_TOKEN`, Secret: 방금 복사한 토큰
2. https://github.com/woojin0128/veridone/actions/workflows/store.yml → **Run workflow** → environment `production` → Run

2~3분 뒤 다음이 모두 끝나 있습니다.

- Polar에 상품 4개(Pro 월간 $9, Pro 연간 $79, Founder 평생 $149, Team 좌석당 연 $190)와 라이선스 키 혜택 2개(`VERIDONE-PRO-…`, `VERIDONE-TEAM-…`, 키당 컴퓨터 3대)가 만들어집니다.
- 상품별 결제 링크가 생기고 `store.json`에 저장됩니다.
- 버전이 1.0.1로 올라가 자동 릴리스되고, 웹사이트 가격표의 결제 버튼이 켜집니다.

워크플로 실행 결과 화면(Summary)에 결제 링크가 정리돼 나옵니다. 다시 실행해도 이미 있는 상품은 그대로 두고 빠진 것만 만듭니다.

> Polar 계정에서 좌석 과금(seat-based pricing)이 막혀 있으면 Team은 자동으로 "5석 묶음 연 $890"(키 1개, 컴퓨터 15대) 상품으로 만들어집니다.

### 1-4. 실제로 사 보기 (꼭 하세요)

1. Polar → Products → Discounts에서 100% 할인 코드를 하나 만듭니다(사용 횟수 1회).
2. 웹사이트에서 "Buy Pro yearly"를 눌러 그 코드로 결제합니다.
3. 결제 완료 화면에 `VERIDONE-PRO-…` 키가 보이는지, 메일이 오는지 확인합니다.
4. Claude Code에서 `/veridone:license activate <키>` → `/veridone:license status`가 Pro로 나오면 성공입니다.
5. Polar 대시보드에서 그 주문을 환불해 보고, `/veridone:license refresh`를 실행하면 "no longer active"가 나오는지 확인합니다.

> 진짜 돈 없이 처음부터 끝까지 시험하고 싶다면 https://sandbox.polar.sh 에 따로 가입해 sandbox 토큰으로 같은 워크플로를 `sandbox`로 실행하고 테스트 카드(4242 4242 4242 4242)로 결제해 보세요. 시험이 끝나면 **반드시** production 토큰으로 바꿔 `production`으로 다시 실행해야 합니다(그래야 store.json이 실제 스토어를 가리킵니다).

---

## 2. 자동화가 하는 일

| 워크플로 | 언제 | 하는 일 |
|---|---|---|
| CI | 모든 push·PR | macOS/Linux × Node 18~24 테스트, `claude plugin validate`, 버전 일치 확인, 사이트 빌드, 규칙 문서 최신 여부 |
| Release | `.claude-plugin/plugin.json`의 버전이 바뀌어 main에 올라올 때 | CI 통과 후 `vX.Y.Z` 태그, `v1` 태그 이동(GitHub Action 사용자용), CHANGELOG로 릴리스 노트와 zip 첨부 |
| Website | 사이트·store.json·버전이 바뀔 때 | `_site` 빌드 후 GitHub Pages 배포 |
| Connect store | 직접 실행 | 위 1-3단계 |

Claude Code 사용자는 플러그인 버전이 바뀌어야 업데이트를 받습니다. 그래서 새 기능을 낼 때는 항상 버전을 올립니다.

### 새 버전 내기

```bash
node tools/bump-version.mjs patch --note "무엇이 바뀌었는지 한 줄"   # 1.0.1 → 1.0.2 (minor, major도 가능)
npm test
git commit -am "Release 1.0.2" && git push
```

push하면 나머지(테스트, 태그, 릴리스, 사이트)는 자동입니다. GitHub 웹에서 `plugin.json`과 `package.json`의 `version`을 직접 고쳐 커밋해도 됩니다.

---

## 3. 고객 대응

| 상황 | 할 일 |
|---|---|
| 환불 요청 | Polar 대시보드 → Orders → Refund. 키는 자동으로 해지되고, 고객의 Veridone은 다음 확인 때(최대 3일) 유료 기능만 꺼집니다. 정책: 첫 구매 14일, 갱신 7일 |
| 키 분실 | 고객 포털(`polar.sh/<slug>/portal`)에서 이메일 로그인으로 다시 볼 수 있다고 안내 |
| 컴퓨터 교체, "maximum number of machines" | 옛 컴퓨터에서 `/veridone:license deactivate`, 또는 고객 포털에서 기기 삭제 |
| Team 좌석 추가 | 구매자가 고객 포털에서 좌석 수를 늘리고 이메일로 배정 |
| 인보이스 결제·폐쇄망 기업 | 오프라인 키 발급(아래) |

### 오프라인 키 (기업 고객용, 필요할 때만)

인터넷이 막힌 환경이나 인보이스 계약 고객에게는 서명된 오프라인 키(`VD1.…`)를 줄 수 있습니다.

```bash
node tools/license-admin.mjs init          # 최초 1회: 서명키 생성(~/.veridone-vendor), 공개키를 코드에 넣음 → 버전 올려 릴리스
node tools/license-admin.mjs issue --email cto@acme.com --org "Acme" --plan team --seats 10 --days 400
node tools/license-admin.mjs list
```

서명용 비밀키(`~/.veridone-vendor/license-signing-key.pem`)는 절대 커밋하거나 공유하지 마세요. 비밀번호 관리자에 백업해 두세요.

---

## 4. 가격 전략

- **무료판을 강하게 유지하세요.** 비슷한 "Stop 훅" 플러그인은 대부분 무료입니다. 설치 수가 곧 매출의 모수입니다.
- **14일 무료 체험이 전환의 핵심입니다.** 카드 없이 한 줄로 시작되고, 끝나기 2일 전과 끝날 때 한 번씩만 알려 줍니다. 팀 규칙을 써 본 사람은 끄기 어렵습니다.
- **돈은 팀에서 나옵니다.** 회사는 끌 수 없는 조직 정책과 코드 스캐닝(SARIF)에 돈을 냅니다. 회사 결제는 개인보다 가격 저항이 낮습니다.
- **Founder 평생권($149)은 런칭 한정입니다.** 초기 현금과 입소문용이니, 판매가 어느 정도 되면(예: 100개) Polar에서 해당 상품을 보관(Archive)하고 Connect store를 다시 실행하세요. 사이트에서 자동으로 빠집니다.
- 가격을 바꾸려면 Polar 대시보드에서 상품 가격을 고친 뒤 `store.json`의 표시 가격(`amount`, `label`)도 같이 고쳐 커밋하세요.
- 원화 환산 참고(환율에 따라 다름): $9 ≈ 1.3만 원, $79 ≈ 11만 원, $149 ≈ 21만 원, $190 ≈ 27만 원.
- 수수료 참고: Polar 기본 5% + 50¢, 미국 외 카드 +1.5%, 정산 수수료 별도. $79 연간 결제 1건이면 대략 $73 안팎이 남습니다.

---

## 5. 유통·마케팅 (매출을 결정하는 단계)

### 5-1. 출시 주간 체크리스트

| 채널 | 할 일 |
|---|---|
| **GitHub** | Releases → v1.0.0 → Edit → "Publish this Action to the GitHub Marketplace" 체크(카테고리: Code quality, Security) |
| **awesome 목록** | hesreallyhim/awesome-claude-code, ccplugins/awesome-claude-code-plugins, ComposioHQ/awesome-claude-plugins, jqueryscript/awesome-claude-code에 한 줄 소개로 PR(각 목록의 기여 규칙 먼저 확인) |
| **플러그인 디렉터리** | awesomeclaudeplugins.com, claudepluginhub.com, buildwithclaude.com 등록 요청 |
| **Anthropic 공식 디렉터리** | claude.ai/directory/manage에서 제출(유료 claude.ai 플랜 필요, 심사 있음). 핵심 기능이 Claude Code 훅이라는 점을 설명에 분명히 적으세요 |
| **Hacker News** | "Show HN: Veridone – stops Claude Code from faking 'done'". 미국 평일 오전(한국 밤 10시~자정)에 올리고 댓글에 빠르게 답하기. 첫 댓글에 측정 결과(10번 중 10번 유출 → 0번)와 평가 방법 링크 |
| **Reddit** | r/ClaudeAI, r/ClaudeCode. 홍보보다 "Claude가 테스트를 몰래 건너뛰는 걸 잡는 법" 같은 경험담 형식 |
| **X·LinkedIn** | 웹사이트 첫 화면의 재생 장면(UNVERIFIED → VERIFIED)을 짧은 화면 녹화로 |
| **국내** | GeekNews(news.hada.io) Show GN, 디스콰이엇, OKKY, 개발자 오픈채팅·디스코드 |

### 5-2. 가장 효과적인 콘텐츠: "잡아내는 장면"

사람들은 기능 목록보다 **Claude가 거짓말하다 걸리는 장면**에 반응합니다. 30~60초 화면 녹화 3개를 만드세요.

1. Claude가 테스트를 돌리지 않고 "done" → Veridone이 막음 → 테스트를 돌려 실제 실패 발견
2. 실패하는 테스트에 `it.skip` → 작성 즉시 차단
3. `npm test | tail -3`으로 실패를 가림 → "실패로 기록" 알림

### 5-3. 글감

- "AI 코딩 에이전트가 테스트를 통과시키는 7가지 꼼수와 잡는 법"
- "`npm test | tail`이 당신에게 거짓말하는 이유"
- "Claude에게 .env를 보여줬더니 10번 중 10번 비밀번호를 옮겨 적었다" (측정 결과 기반)
- "Claude Code 훅으로 팀 코딩 규칙을 강제하는 법" (→ Pro 팀 규칙)

### 5-4. 지표

- 매주: GitHub 스타, Insights → Traffic(방문·클론), Polar 매출·체험 전환. 사용량 텔레메트리는 없으므로(개인정보 보호가 강점) 이 숫자들이 대리 지표입니다.
- 이슈에는 1~2일 안에 답하세요. 초기 사용자의 신뢰가 곧 입소문입니다.

---

## 6. 현실적인 기대치 (가정에 기반한 예시)

아래는 **가정**이지 보장이 아닙니다. 개발자 도구의 무료→유료 전환율은 흔히 1~3%로 봅니다.

| 시나리오 | 6개월 후 실사용자 | 전환 | 연 매출(대략) |
|---|---|---|---|
| 보수적 | 300명 | Pro 3명 | 약 $240 |
| 기본 | 2,000명 | Pro 40명 + Team 2곳(5석) | 약 $5,100 |
| 낙관적 | 10,000명 | Pro 300명 + Team 10곳(5석) | 약 $33,000 |

차이를 만드는 건 거의 전부 5단계 유통입니다.

---

## 7. 세무·법률 체크 (요약, 세무사 확인 필수)

- **사업자:** "응용 소프트웨어 개발 및 공급업" 계열이 일반적입니다. 정확한 업종코드는 홈택스나 세무사에게 확인하세요.
- **해외 매출:** Polar가 법적 판매자이고 당신은 정산을 받는 구조입니다. 영세율 적용 여부와 외화 입금 증빙(정산 내역서)을 세무사와 확인하고, 정산 내역은 매달 PDF로 보관하세요.
- **종합소득세:** 매년 5월. 결제 수수료, 장비 등 필요경비 증빙을 모아 두세요.
- **약관·정책:** 사이트의 이용약관·개인정보 처리방침·환불 정책은 일반적인 내용으로 작성해 둔 초안입니다. 판매자 표기가 GitHub 아이디(woojin0128)로 되어 있으니, 상호로 바꾸려면 `node tools/configure-publisher.mjs --github woojin0128/veridone --author "상호명"` 후 커밋하세요. 매출이 커지면 법률 전문가 검토를 받으세요.
- **상표:** 수익이 나기 시작하면 KIPRIS에서 "Veridone"을 검색한 뒤 제9류(소프트웨어)·제42류 출원을 검토하세요.
- **라이선스:** Elastic License 2.0은 소스를 보고 쓰고 고칠 수 있지만, 호스팅 서비스로 재판매하거나 라이선스 키 검사를 우회·제거하는 것을 금지합니다.

---

## 8. 다음 버전 아이디어

1. **팀 대시보드(SaaS):** 팀원들의 `veridone report --json`을 모아 "이번 달 AI가 시도한 꼼수 N건"을 보여주는 웹 서비스. 월 구독으로 매출 단위를 키울 수 있습니다(동의 기반).
2. **엔터프라이즈:** 연간 계약, 인보이스 결제(오프라인 키), 보안 설문 응대.
3. **다른 에이전트 지원:** CLI 검사는 이미 에이전트와 무관합니다. Codex, Cursor 등의 훅 규격 어댑터를 붙이면 시장이 넓어집니다.

---

## 9. 저장소를 조직으로 옮기고 싶다면

GitHub 조직(예: `veridone-dev`)을 만들고 저장소를 Transfer한 뒤:

```bash
node tools/configure-publisher.mjs --github veridone-dev/veridone
git commit -am "Move to veridone-dev" && git push
```

모든 링크(마켓플레이스, Action, 사이트, 스키마)가 바뀝니다. 기존 사용자는 GitHub 리디렉션 덕분에 계속 업데이트를 받지만, 안내 공지를 한 번 해 두세요. Pages 사이트 주소도 바뀌므로 Polar 조직 설정의 웹사이트 주소도 고쳐 주세요.

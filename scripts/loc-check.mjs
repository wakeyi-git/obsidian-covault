// LOC 캡 검사: 소스 파일이 비대해지는 회귀를 막는다(리팩토링 가드레일).
// 규칙
//  - 일반 소스 *.ts(테스트 제외): GENERAL_CAP(500줄) 초과 시 실패.
//  - OVERRIDES: 파일별 캡. main.ts는 리팩토링이 진행되며 낮춰가는 ratchet(목표 600).
//    SettingsTab/ClassroomController/RealtimeManager는 이번 라운드 범위 밖이라 현재값으로 고정(성장 차단).
//  - override 파일이 일반 캡 이하로 줄면 안내(allowlist에서 제거 가능).
import fs from "node:fs";
import path from "node:path";

const GENERAL_CAP = 500;

// 파일별 상한(줄). 리팩토링 진척에 맞춰 main.ts 값을 낮춘다. 최종 목표: src/main.ts <= 600.
// 2026-06 평가 H-7 조치: 이 검사를 CI에 연결하면서, 그 사이 캡을 넘긴 파일들을 현재값으로
// ratchet 재고정했다(성장 차단). 분해(main.ts PanelHost 컴포지션 등)는 별도 후속 — 평가 보고서 M-12.
const OVERRIDES = {
	// main.ts: M-12 완료 — PanelHost를 컨트롤러 컴포지션(src/panelHost.ts)으로 조립해 1178→719.
	// 남은 것은 수명주기·DI 배선·SettingsHost 1줄 위임. 이 값은 실측 ratchet(성장 차단).
	"src/main.ts": 747, // +토큰 Secret Storage(S-1)·기기별 계정 위임(S-2) 배선
	"src/settings/SettingsTab.ts": 613, // 평가 P2-2/P2-3: 매니저 섹션을 managerSection.ts·managerCards.ts로 분할(1148→613). ratchet 하향.
	// ClassroomController.ts: 평가 P2-3에서 Notice/Assignment/Routine/Message 컨트롤러로 분할(전부 일반 캡 이하) — 제거됨.
	"src/core/realtime/RealtimeManager.ts": 732, // 평가 P2-1: 백오프 로직을 retryBackoff.ts로 추출(735→732). provider 주입·md/excalidraw 전략 분리는 후속(라이브 서버 수동 검증 필요).
	// 문서 모델: 타입 선언 + 타입 가드(평가 H-8) 위주라 캡을 너그럽게 둔다.
	"src/core/model/types.ts": 600,
};

function walk(dir) {
	const out = [];
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const p = path.join(dir, entry.name);
		if (entry.isDirectory()) out.push(...walk(p));
		else if (entry.isFile() && p.endsWith(".ts") && !p.endsWith(".test.ts")) out.push(p);
	}
	return out;
}

const files = walk("src");
const violations = [];
const loosenable = [];

for (const file of files) {
	const rel = file.split(path.sep).join("/");
	const lines = (fs.readFileSync(file, "utf8").match(/\n/g) || []).length; // wc -l 의미(개행 수)
	const cap = OVERRIDES[rel] ?? GENERAL_CAP;
	if (lines > cap) violations.push(`${rel}: ${lines}줄 > ${cap}`);
	if (rel in OVERRIDES && lines <= GENERAL_CAP) loosenable.push(`${rel}: ${lines}줄 ≤ ${GENERAL_CAP} → allowlist에서 제거 가능`);
}

if (violations.length) {
	console.error("✗ LOC 캡 초과:");
	for (const v of violations) console.error("   " + v);
	process.exit(1);
}
for (const m of loosenable) console.log("ℹ " + m);
console.log(`loc: 소스 ${files.length}개 — 일반 캡 ${GENERAL_CAP}, main.ts 캡 ${OVERRIDES["src/main.ts"]} — OK`);

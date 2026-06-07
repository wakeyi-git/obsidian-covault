// i18n 점검(계층형 JSON): en/ko 키 패리티(불일치 실패) + 사용 t() 키 ⊆ en(실패).
// 타입안전 t()가 컴파일에서 "사용 키 ⊆ en"을 이미 보장하므로, 여기선 로케일 간 누락을 주로 본다.
import fs from "node:fs";
import path from "node:path";

const en = JSON.parse(fs.readFileSync("src/i18n/locales/en.json", "utf8"));
const ko = JSON.parse(fs.readFileSync("src/i18n/locales/ko.json", "utf8"));

function flatten(obj, prefix = "") {
	const out = new Set();
	for (const [k, v] of Object.entries(obj)) {
		const key = prefix ? `${prefix}.${k}` : k;
		if (v && typeof v === "object") for (const x of flatten(v, key)) out.add(x);
		else out.add(key);
	}
	return out;
}

const enKeys = flatten(en);
const koKeys = flatten(ko);
const missingInKo = [...enKeys].filter((k) => !koKeys.has(k));
const missingInEn = [...koKeys].filter((k) => !enKeys.has(k));

function walk(dir) {
	let out = [];
	for (const f of fs.readdirSync(dir)) {
		const p = path.join(dir, f);
		const s = fs.statSync(p);
		if (s.isDirectory()) out = out.concat(walk(p));
		else if (f.endsWith(".ts") && !f.endsWith(".test.ts") && !p.includes("i18n/index.ts")) out.push(p);
	}
	return out;
}

const used = new Set();
for (const file of walk("src")) {
	const src = fs.readFileSync(file, "utf8");
	for (const m of src.matchAll(/\bt\(\s*"([a-z0-9_]+(?:\.[a-z0-9_]+)+)"/g)) used.add(m[1]);
}
const usedMissing = [...used].filter((k) => !enKeys.has(k));

// 동적 키(템플릿 리터럴)로 참조되는 접두사 — 정적 grep으로 못 잡으므로 미사용 판정에서 제외.
// 예: t(`dashboard.wd_${k}`) → dashboard.wd_sun..sat
const dynamicPrefixes = ["dashboard.wd_"];
const unused = [...enKeys].filter((k) => !used.has(k) && !dynamicPrefixes.some((p) => k.startsWith(p)));

console.log(
	`i18n: en ${enKeys.size}키, ko ${koKeys.size}키, 사용 ${used.size}키, ko누락 ${missingInKo.length}, en누락 ${missingInEn.length}, 사용미정의 ${usedMissing.length}, 미사용 ${unused.length}`,
);
// 미사용 키는 경고만(동적 키 오탐 가능성으로 실패시키지 않음).
if (unused.length) console.warn("⚠ 미사용 키(정리 후보):", unused);
const fail = missingInKo.length || missingInEn.length || usedMissing.length;
if (missingInKo.length) console.error("✗ ko.json 누락:", missingInKo);
if (missingInEn.length) console.error("✗ en.json 누락:", missingInEn);
if (usedMissing.length) console.error("✗ 정의되지 않은 키 사용:", usedMissing);
if (fail) process.exit(1);

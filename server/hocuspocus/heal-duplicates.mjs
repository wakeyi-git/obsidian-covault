/**
 * 박제된 실시간 노트 중복(ABCABC) **1회 치유** 스크립트.
 *
 * 배경: mirror 폴더 전체가 자동 실시간이 되던 시절, 텍스트↔CRDT 재조정의 wholesale 재삽입으로 노트가 통째로
 * 2배(또는 2^k배)로 누적됐다. 파일별 옵트인(이후 커밋)과 서버 diff 병합으로 **재발은 막았지만**, 이미 CouchDB의
 * note 본문·ystate에 박제된 분은 깨끗한 기준이 없어 자동 치유되지 않는다. 이 스크립트가 그 박제분을 1회 정리한다.
 *
 * 동작: 각 mirror_*·share_* DB의 note: 문서 중 본문이 **정확히 2^k배 자기반복**(앞 절반 == 뒤 절반, 반복)이면
 * 한 사본으로 collapse해 다시 쓰고(version+1, 기기=covault-heal=non-RT), 그 파일의 ystate:<dbPath> 사이드카를
 * 삭제한다. → 복제로 학생 볼트까지 deduped 파일이 전파되고, 다음 실시간 로드는 깨끗한 note로 재시드/수렴한다.
 *
 * 안전장치: 기본 **DRY-RUN**(보고만). 적용은 HEAL_APPLY=1. 최소 반쪽 길이(HEAL_MIN_LEN, 기본 200)로 오탐 방지.
 *
 * ⚠️ 실행 전 제출 조건:
 *   - 플러그인(파일별 옵트인)을 먼저 배포해 mirror 노트가 자동 실시간이 아니어야 한다(아니면 살아있는 doubled
 *     세션이 collapse한 note를 즉시 다시 덮는다). 대상 노트가 어디서도 실시간 세션으로 열려있지 않아야 안전하다.
 *   - 서버 diff 병합(Part 4) 배포 후 권장.
 *
 * 사용(NAS 컨테이너 안에서 — COUCHDB_URL/USER/PASSWORD 환경변수 사용):
 *   docker cp heal-duplicates.mjs covault-realtime:/tmp/heal.mjs
 *   docker exec covault-realtime node /tmp/heal.mjs                       # 미리보기(전체)
 *   docker exec -e HEAL_DBS=mirror_student_5,mirror_student_3 covault-realtime node /tmp/heal.mjs   # 일부만 미리보기
 *   docker exec -e HEAL_APPLY=1 covault-realtime node /tmp/heal.mjs       # 적용
 */

import crypto from "crypto";

const BASE = (process.env.COUCHDB_URL || "").replace(/\/+$/, "");
const AUTH = "Basic " + Buffer.from(`${process.env.COUCHDB_USER || ""}:${process.env.COUCHDB_PASSWORD || ""}`).toString("base64");
const APPLY = process.env.HEAL_APPLY === "1";
const MIN_LEN = parseInt(process.env.HEAL_MIN_LEN || "200", 10); // 반쪽 최소 길이(오탐 방지)
const DBS_ENV = (process.env.HEAL_DBS || process.env.HEAL_DB || "").split(",").map((s) => s.trim()).filter(Boolean);
const HEAL_DEVICE = "covault-heal"; // non-RT → 다음 로드의 수렴(diff)이 발동

const sha256 = (s) => crypto.createHash("sha256").update(s, "utf8").digest("hex");

async function cdb(path, opts = {}) {
	const res = await fetch(BASE + path, { ...opts, headers: { Authorization: AUTH, "Content-Type": "application/json", ...(opts.headers || {}) } });
	if (res.status === 404) return null;
	if (!res.ok) throw new Error(`${opts.method || "GET"} ${path} -> HTTP ${res.status}`);
	return res.json();
}

/** content가 정확히 2^k배 자기반복이면 최소 단위(한 사본)를 반환, 아니면 null. 각 단계의 반쪽이 MIN_LEN 이상일 때만. */
function collapsedUnit(content) {
	let s = content;
	let collapsed = false;
	while (s.length >= 2 && s.length % 2 === 0) {
		const half = s.length / 2;
		if (half >= MIN_LEN && s.slice(0, half) === s.slice(half)) {
			s = s.slice(0, half);
			collapsed = true;
		} else break;
	}
	return collapsed ? s : null;
}

async function listDbs() {
	if (DBS_ENV.length) return DBS_ENV;
	const all = await cdb("/_all_dbs").catch(() => null);
	if (!all) throw new Error("_all_dbs 접근 불가(서버 계정이 admin 아님) — HEAL_DBS=mirror_a,share_b 로 대상 지정");
	return all.filter((d) => d.startsWith("mirror_") || d.startsWith("share_"));
}

async function healDb(db) {
	const enc = encodeURIComponent;
	const HI = "￿"; // note: prefix 상한 경계 문자(어떤 정상 id 글자보다 큼)
	const q = `include_docs=true&startkey=${enc(JSON.stringify("note:"))}&endkey=${enc(JSON.stringify("note:" + HI))}`;
	const rows = await cdb(`/${enc(db)}/_all_docs?${q}`);
	let n = 0;
	for (const r of rows?.rows ?? []) {
		const doc = r.doc;
		if (!doc || doc.deleted || typeof doc.content !== "string") continue;
		const unit = collapsedUnit(doc.content);
		if (!unit) continue;
		n++;
		console.log(`${APPLY ? "[heal]" : "[dry] "} ${db}/${doc._id}  ${doc.content.length} → ${unit.length} chars (×${doc.content.length / unit.length})`);
		if (!APPLY) continue;
		const now = Date.now();
		await cdb(`/${enc(db)}/${enc(doc._id)}`, {
			method: "PUT",
			body: JSON.stringify({ ...doc, content: unit, contentHash: sha256(unit), mtime: now, version: (doc.version ?? 0) + 1, lastModifiedDeviceId: HEAL_DEVICE, updatedAt: new Date(now).toISOString() }),
		});
		const dbPath = doc.path ?? doc._id.replace(/^note:/, "");
		const ys = await cdb(`/${enc(db)}/${enc("ystate:" + dbPath)}`);
		if (ys && ys._rev) {
			await cdb(`/${enc(db)}/${enc("ystate:" + dbPath)}?rev=${ys._rev}`, { method: "DELETE" });
			console.log(`         ystate 제거: ${dbPath}`);
		}
	}
	return n;
}

if (!BASE) {
	console.error("COUCHDB_URL 미설정 — 컨테이너 안에서 실행하세요(docker exec covault-realtime ...).");
	process.exit(1);
}
const dbs = await listDbs();
console.log(`${APPLY ? "■ 적용 모드" : "□ DRY-RUN(미적용)"} — DB ${dbs.length}개, 반쪽 최소 길이 ${MIN_LEN}`);
let total = 0;
for (const db of dbs) {
	try {
		total += await healDb(db);
	} catch (e) {
		console.error(`  ${db}: ${e.message}`);
	}
}
console.log(`\n대상 ${total}건${APPLY ? " 치유 완료" : ""}.`);
if (!APPLY && total) console.log("적용하려면 같은 명령에 -e HEAL_APPLY=1 추가.");

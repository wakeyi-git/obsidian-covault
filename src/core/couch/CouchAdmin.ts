import { createObsidianFetch } from "./obsidianFetch";
import { t } from "../../i18n";

/**
 * CouchDB 관리자 프로비저닝. 기술문서 §13 / §22.
 *
 * 교사 기기에서 admin 자격증명으로 학생을 프로비저닝한다:
 *  1) _users 에 학생 계정 생성
 *  2) 학생 mirror DB 생성
 *  3) DB _security 를 학생 본인만 멤버로 설정 → 다른 학생은 403
 *
 * requestUrl 기반 fetch(createObsidianFetch)를 써서 데스크톱/모바일 모두 동작(CORS 우회).
 */
export class CouchAdmin {
	private readonly fetchImpl: typeof fetch;

	constructor(
		private baseUrl: string,
		adminUser: string,
		adminPass: string,
	) {
		this.fetchImpl = createObsidianFetch(adminUser, adminPass);
	}

	private url(path: string): string {
		return `${this.baseUrl.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
	}

	/** 서버 오류 사유를 로그/메시지에 실을 때 과도한 본문(대형 HTML 등)을 잘라 내부정보 노출을 줄인다. */
	private reasonOf(r: { json?: any; text?: string }): string {
		const s = String(r.json?.reason ?? r.text ?? "");
		return s.length > 200 ? `${s.slice(0, 200)}…` : s;
	}

	private async req(
		method: string,
		path: string,
		body?: unknown,
		extraHeaders?: Record<string, string>,
	): Promise<{ status: number; json: any; text: string }> {
		const headers: Record<string, string> = { ...(extraHeaders ?? {}) };
		if (body !== undefined) headers["Content-Type"] = "application/json";
		const resp = await this.fetchImpl(this.url(path), {
			method,
			headers: Object.keys(headers).length ? headers : undefined,
			body: body !== undefined ? JSON.stringify(body) : undefined,
		});
		const text = await resp.text();
		let json: any = undefined;
		try {
			json = text ? JSON.parse(text) : undefined;
		} catch {
			/* non-JSON */
		}
		return { status: resp.status, json, text };
	}

	/** 삭제된(tombstone) 문서의 최신 leaf _rev를 찾는다(없으면 null). 재생성 시 충돌 방지에 사용. */
	private async getDeletedRev(path: string): Promise<string | null> {
		const res = await this.req("GET", `${path}?open_revs=all`, undefined, { Accept: "application/json" });
		if (!Array.isArray(res.json)) return null;
		for (const entry of res.json) {
			if (entry?.ok?._rev) return entry.ok._rev as string;
		}
		return null;
	}

	/**
	 * admin 연결/권한 확인. 서버 루트 도달 + 실제 프로비저닝 권한(`_users` 접근)을 확인한다.
	 * `GET /` 만으로는 기본 인증이 맞아도 `_users`/`_security` 권한 부족을 못 잡아 초대/배포 단계에서
	 * 뒤늦게 실패하므로, `_users` DB 조회로 server-admin 권한을 미리 검증한다(비권한이면 403).
	 */
	async checkAdmin(): Promise<{ ok: boolean; error?: string }> {
		const root = await this.req("GET", "/");
		if (root.status === 401 || root.status === 403)
			return { ok: false, error: t("couch.authentication_error_http", { status: root.status }) };
		if (root.status >= 400) return { ok: false, error: t("couch.server_error_http", { status: root.status }) };

		// _users 접근(서버 관리자 전용) — 학생 계정 생성 권한의 대리 검증.
		const users = await this.req("GET", "/_users");
		if (users.status === 401 || users.status === 403)
			return { ok: false, error: t("couch.admin_provisioning_forbidden", { status: users.status }) };
		if (users.status >= 400) return { ok: false, error: t("couch.server_error_http", { status: users.status }) };
		return { ok: true };
	}

	/**
	 * 학생 프로비저닝(멱등). 계정/DB/권한을 보장한다.
	 * 이미 있는 계정은 비밀번호를 갱신한다(초대 재발급).
	 */
	async provisionMember(opts: {
		username: string;
		password: string;
		remoteDb: string;
	}): Promise<{ ok: boolean; error?: string }> {
		const { username, password, remoteDb } = opts;
		const userId = `org.couchdb.user:${username}`;
		const userPath = `_users/${encodeURIComponent(userId)}`;

		// 1) 학생 계정 생성/갱신 (비밀번호 반드시 반영). 409(rev 충돌)이면 최신 _rev로 재시도.
		//    409를 성공으로 넘기면 옛 비밀번호가 남아 학생이 401을 맞으므로 반드시 끝까지 갱신한다.
		let userOk = false;
		for (let attempt = 0; attempt < 3 && !userOk; attempt++) {
			const existing = await this.req("GET", userPath);
			const userDoc: Record<string, unknown> = { _id: userId, name: username, password, roles: [], type: "user" };
			if (existing.status === 200 && existing.json?._rev) {
				userDoc._rev = existing.json._rev;
			} else if (existing.status === 404) {
				// 삭제된(tombstone) 계정일 수 있음 → 삭제 leaf rev로 덮어써 재생성(409 방지)
				const delRev = await this.getDeletedRev(userPath);
				if (delRev) userDoc._rev = delRev;
			}
			const putUser = await this.req("PUT", userPath, userDoc);
			if (putUser.status < 300) {
				userOk = true;
			} else if (putUser.status === 409) {
				continue; // 최신 _rev로 재시도
			} else {
				return {
					ok: false,
					error: t("couch.failed_to_create_account_http", {
						status: putUser.status,
						reason: this.reasonOf(putUser),
					}),
				};
			}
		}
		if (!userOk) return { ok: false, error: t("couch.failed_to_update_account_password_repeated") };

		// 2) mirror DB 생성 (이미 있으면 412/409 무시)
		const putDb = await this.req("PUT", encodeURIComponent(remoteDb));
		if (putDb.status >= 400 && putDb.status !== 412 && putDb.status !== 409) {
			return {
				ok: false,
				error: t("couch.failed_to_create_db_http", {
					status: putDb.status,
					reason: this.reasonOf(putDb),
				}),
			};
		}

		// 3) _security: 학생 본인만 멤버 (서버 admin은 항상 접근)
		const sec = await this.setSecurity(remoteDb, [username]);
		if (!sec.ok) return sec;
		return { ok: true };
	}

	/**
	 * 관리자 개인 볼트 동기화 DB 프로비저닝(멱등). DB 생성 + _security 멤버=관리자 계정.
	 * 관리자는 server-admin이라 항상 접근 가능하며, 다기기에서 같은 DB로 동기화/백업하는 용도.
	 */
	async provisionPersonalDb(remoteDb: string, username: string): Promise<{ ok: boolean; error?: string }> {
		const putDb = await this.req("PUT", encodeURIComponent(remoteDb));
		if (putDb.status >= 400 && putDb.status !== 412 && putDb.status !== 409) {
			return { ok: false, error: t("couch.failed_to_create_db_http", { status: putDb.status, reason: this.reasonOf(putDb) }) };
		}
		return this.setSecurity(remoteDb, [username]);
	}

	/**
	 * 공유 공간 프로비저닝(멱등). DB 생성 + _security 멤버 = 참여 학생 계정들.
	 * 학생 계정은 개인 프로비저닝으로 이미 존재한다고 가정.
	 */
	async provisionSharedSpace(remoteDb: string, memberUsernames: string[]): Promise<{ ok: boolean; error?: string }> {
		const putDb = await this.req("PUT", encodeURIComponent(remoteDb));
		if (putDb.status >= 400 && putDb.status !== 412 && putDb.status !== 409) {
			return {
				ok: false,
				error: t("couch.failed_to_create_shared_db_http", {
					status: putDb.status,
					reason: this.reasonOf(putDb),
				}),
			};
		}
		const sec = await this.setSecurity(remoteDb, memberUsernames);
		if (!sec.ok) return sec;
		// 서버측 쓰기 권한 강제(학생=member): 교사 게시물(메타) 보호 + 응답은 본인 것만.
		// 교사는 server-admin 자격증명으로 쓰므로 validate를 우회한다. note/asset(파일) 협업은 영향 없음.
		return this.putValidateDesignDoc(remoteDb);
	}

	/**
	 * 공유 DB에 validate_doc_update 디자인 문서를 배포(멱등). 서버 admin(_admin=교사)은 우회.
	 * member(학생)는: notice/timetable/routine/assignment(교사 메타) 쓰기 금지, response는 byUser=본인만.
	 * note/asset/feedback 등 협업 콘텐츠는 제한하지 않는다(모둠 공유 공간 호환).
	 */
	private async putValidateDesignDoc(remoteDb: string): Promise<{ ok: boolean; error?: string }> {
		const validate =
			"function (newDoc, oldDoc, userCtx) {\n" +
			"  if (userCtx && userCtx.roles && userCtx.roles.indexOf('_admin') >= 0) return;\n" +
			"  var t = newDoc.type || (oldDoc && oldDoc.type);\n" +
			"  var teacherOnly = ['notice','timetable','routine','assignment'];\n" +
			"  if (teacherOnly.indexOf(t) >= 0) throw({ forbidden: 'teacher only' });\n" +
			// response(읽음/댓글)는 자기 소유만. message(대화)는 협업 콘텐츠(note/feedback와 동일)로 보고
			// 소유 검사하지 않는다 — byUser는 앱 정체성(교사='manager')이라 CouchDB 계정명과 달라 정상 메시지가
			// 거부되던 문제를 피한다. 쓰기 권한은 DB _security(구성원/관리자)가 이미 제한한다.
			"  if (t === 'response') {\n" +
			"    var owner = newDoc._deleted ? (oldDoc && oldDoc.byUser) : newDoc.byUser;\n" +
			"    if (owner && owner !== userCtx.name) throw({ forbidden: 'own doc only' });\n" +
			"  }\n" +
			"}";
		const path = `${encodeURIComponent(remoteDb)}/_design/auth`;
		for (let attempt = 0; attempt < 3; attempt++) {
			const existing = await this.req("GET", path);
			const body: Record<string, unknown> = { _id: "_design/auth", language: "javascript", validate_doc_update: validate };
			if (existing.status === 200 && existing.json?._rev) body._rev = existing.json._rev;
			const put = await this.req("PUT", path, body);
			if (put.status < 300) return { ok: true };
			if (put.status === 409) continue;
			return {
				ok: false,
				error: t("couch.failed_to_write_document_http", { status: put.status, reason: this.reasonOf(put) }),
			};
		}
		return { ok: false, error: t("couch.failed_to_write_document_repeated_rev") };
	}

	private async setSecurity(remoteDb: string, members: string[]): Promise<{ ok: boolean; error?: string }> {
		const security = { admins: { names: [], roles: [] }, members: { names: members, roles: [] } };
		const putSec = await this.req("PUT", `${encodeURIComponent(remoteDb)}/_security`, security);
		if (putSec.status >= 400) {
			return {
				ok: false,
				error: t("couch.failed_to_set_permissions_http", {
					status: putSec.status,
					reason: this.reasonOf(putSec),
				}),
			};
		}
		return { ok: true };
	}

	/** DB 영구 삭제. 이미 없으면(404) 성공으로 본다. 서버 데이터 초기화용. */
	async deleteDatabase(db: string): Promise<{ ok: boolean; error?: string }> {
		const res = await this.req("DELETE", encodeURIComponent(db));
		if (res.status < 300 || res.status === 404) return { ok: true };
		return {
			ok: false,
			error: t("couch.failed_to_delete_db_http", {
				status: res.status,
				reason: this.reasonOf(res),
			}),
		};
	}

	/**
	 * 학생 _users 계정 삭제. 이미 없으면 성공. 완전 초기화용.
	 * 삭제 후 tombstone을 purge해, 같은 ID로 재초대 시 rev 충돌 없이 깨끗이 재생성되게 한다.
	 */
	async deleteUser(username: string): Promise<{ ok: boolean; error?: string }> {
		const userId = `org.couchdb.user:${username}`;
		const path = `_users/${encodeURIComponent(userId)}`;
		const existing = await this.req("GET", path);
		if (existing.status === 404) return { ok: true };
		if (existing.status >= 400)
			return { ok: false, error: t("couch.failed_to_look_up_account_http", { status: existing.status }) };
		const rev = existing.json?._rev;
		if (!rev) return { ok: true };
		const del = await this.req("DELETE", `${path}?rev=${encodeURIComponent(rev)}`);
		if (del.status >= 300 && del.status !== 404) {
			return {
				ok: false,
				error: t("couch.failed_to_delete_account_http", {
					status: del.status,
					reason: this.reasonOf(del),
				}),
			};
		}
		// tombstone 제거(재생성 충돌 방지). 미지원/실패해도 삭제 자체는 성공으로 본다.
		const delRev = del.json?.rev ?? rev;
		await this.req("POST", "_users/_purge", { [userId]: [delRev] });
		return { ok: true };
	}

	/** 임의 DB에 문서 upsert(멱등). 학생 mirror DB에 shares 문서를 기록하는 데 사용. */
	async putDoc<T extends { _id: string }>(db: string, doc: T): Promise<{ ok: boolean; error?: string }> {
		const path = `${encodeURIComponent(db)}/${encodeURIComponent(doc._id)}`;
		for (let attempt = 0; attempt < 3; attempt++) {
			const existing = await this.req("GET", path);
			const body: Record<string, unknown> = { ...doc };
			if (existing.status === 200 && existing.json?._rev) body._rev = existing.json._rev;
			const put = await this.req("PUT", path, body);
			if (put.status < 300) return { ok: true };
			if (put.status === 409) continue;
			return {
				ok: false,
				error: t("couch.failed_to_write_document_http", {
					status: put.status,
					reason: this.reasonOf(put),
				}),
			};
		}
		return { ok: false, error: t("couch.failed_to_write_document_repeated_rev") };
	}
}

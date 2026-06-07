import { CoreServices } from "../CoreServices";
import { errMessage } from "../util/err";
import { t } from "../../i18n";

/**
 * 현재 설정으로 새 PouchService를 만들어 연결/권한을 테스트한다. 기술문서 §22.3.
 * 실행 중인 엔진의 (이미 만들어진) 연결이 아니라 항상 최신 설정으로 검사하므로,
 * 설정을 바꾼 직후에도 정확하다. HTTP 상태를 신뢰의 기준으로 삼는다.
 */
export async function testConnection(core: CoreServices, dbName?: string): Promise<void> {
	const log = core.logger;
	const s = core.settings;
	if (!s.couchdbUrl) {
		log.warn(t("diagnostics.couchdb_url_is_empty_please_enter"), true);
		return;
	}
	const db = dbName ?? s.remoteDb;
	log.info(t("diagnostics.connection_test", { url: s.couchdbUrl, db }));

	const pouch = core.createPouch(db);
	try {
		let raw: { status: number; length: number; snippet: string };
		try {
			raw = await pouch.rawInfo();
		} catch (e) {
			log.error(
				t("diagnostics.connection_failed_server_unreachable", { err: errMessage(e) }),
				true,
			);
			return;
		}
		if (raw.status === 401) {
			log.error(t("diagnostics.connection_failed_auth_error_http_401"), true);
			return;
		}
		if (raw.status === 403) {
			log.warn(
				t("diagnostics.no_permission_http_403_this_account", {
					db,
				}),
				true,
			);
			return;
		}
		if (raw.status >= 400) {
			log.error(t("diagnostics.connection_failed_http", { status: raw.status, snippet: raw.snippet }), true);
			return;
		}
		const res = await pouch.ping();
		if (res.ok) log.ok(t("diagnostics.connected_docs", { db, count: res.info?.doc_count ?? "?" }), true);
		else log.error(t("diagnostics.connection_failed", { err: res.error ?? "" }), true);
	} finally {
		await pouch.close();
	}
}

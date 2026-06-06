import { CoreServices } from "../CoreServices";
import { t } from "../../i18n";

/** 진단 대상 DB. label은 학생/공유 식별. */
export interface DiagTarget {
	db: string;
	label: string;
}

/**
 * 종합 연결 진단. 기술문서 §22.3 / §24.6.
 * 서버 도달 + 각 mirror/share DB의 읽기·쓰기 권한을 한 번에 점검해 로그 패널에 정리한다.
 * 다른 학생 DB의 403은 권한 격리가 정상 동작하는 신호로 표기한다.
 */
export async function runDiagnostics(core: CoreServices, targets: DiagTarget[]): Promise<void> {
	const log = core.logger;
	const s = core.settings;

	log.info(t("diagnostics.full_diagnostics_started"), true);
	log.info(
		t("diagnostics.settings_role_class_url_autosync_attachments",
			{
				role: s.role,
				workspaceId: s.workspaceId,
				url: s.couchdbUrl ? t("common.set") : t("common.none"),
				autoSync: String(s.autoSync),
				syncAssets: String(s.syncAssets),
				maxMB: s.maxAttachmentMB,
				pauseWhenHidden: String(s.pauseWhenHidden),
				realtimeEnabled: String(s.realtimeEnabled),
			},
		),
	);

	if (!s.couchdbUrl) {
		log.warn(t("diagnostics.no_couchdb_url_please_enter_it"), true);
		return;
	}
	if (targets.length === 0) {
		log.warn(t("diagnostics.no_db_to_diagnose_teacher_add"), true);
		return;
	}

	let okCount = 0;
	let failCount = 0;

	for (const { db, label } of targets) {
		const pouch = core.createPouch(db);
		try {
			// 읽기(도달 + 권한)
			let status = 0;
			try {
				const raw = await pouch.rawInfo();
				status = raw.status;
			} catch (e) {
				log.error(
					t("diagnostics.server_unreachable", {
						label,
						db,
						err: e instanceof Error ? e.message : String(e),
					}),
				);
				failCount++;
				continue;
			}
			if (status === 401) {
				log.error(t("diagnostics.auth_error_401_check_username_password", { label, db }));
				failCount++;
				continue;
			}
			if (status === 403) {
				log.warn(t("diagnostics.access_denied_403_for_another_student", { label, db }));
				continue;
			}
			if (status >= 400) {
				log.error(t("diagnostics.http", { label, db, status }));
				failCount++;
				continue;
			}

			// 쓰기 권한
			const w = await pouch.probeWrite();
			if (w.ok) {
				log.ok(t("diagnostics.read_ok_write_ok", { label, db }));
				okCount++;
			} else if (w.status === 401 || w.status === 403) {
				log.warn(t("diagnostics.read_ok_no_write_permission", { label, db, status: w.status }));
			} else {
				log.error(t("diagnostics.read_ok_write_failed", { label, db, err: w.error ?? "" }));
				failCount++;
			}
		} finally {
			await pouch.close();
		}
	}

	log.info(t("diagnostics.diagnostics_complete_ok_failed", { ok: okCount, fail: failCount }), true);
}

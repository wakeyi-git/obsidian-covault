import { MirrorContext } from "./MirrorContext";
import { describeCouchPassword } from "../secret";
import { t } from "../../i18n";

/** 인증/계정잠금 류 오류 판별(재시도 폭주 방지). */
export function isAuthError(message: string): boolean {
	return /unauthorized|name or password|password is incorrect|forbidden|locked|\b401\b|\b403\b/i.test(message);
}

/**
 * 인증 실패가 **어느 자격증명 경로**에서 비롯됐는지 로그(값 비노출). 이번 계정 잠금의 출처를 좁히기 위함:
 *  - source="empty": 이 기기에 비밀번호가 없어 빈 로그인 → 서버가 잠근 것. 초대 재스캔(재온보딩) 필요.
 *  - source="plaintext-fallback"/"secret-storage"인데도 실패: 비밀번호는 있으나 서버가 거부 — 서버측
 *    비밀번호 회전·만료·스테일 초대. 관리자 측 자격증명/초대 갱신 필요.
 * 같은 사용자명·비밀번호를 모든 mirror/share DB가 공유하므로, 첫 실패 DB의 진단이 전체를 대표한다.
 */
export function logAuthDiagnostic(ctx: MirrorContext, db: string): void {
	const s = ctx.settings;
	const cred = describeCouchPassword(ctx.app, s.password);
	ctx.logger.warn(
		t("sync.auth_failure_diagnostic", {
			db,
			user: s.username ? t("common.set") : t("common.none"),
			source: cred.source,
			ss: cred.hasSecretStorage ? t("common.on") : t("common.off"),
		}),
		true,
	);
}

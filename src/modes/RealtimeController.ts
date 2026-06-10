import { App } from "obsidian";
import { CoVaultSettings, MemberConfig, SharedSpace } from "../settings/types";
import { RealtimeManager } from "../core/realtime/RealtimeManager";
import { mintSpaceToken } from "../core/realtime/spaceToken";
import { getYjsSecret } from "../core/secret";

/**
 * RealtimeController 의존성. settings는 load/import에서 교체되므로 getter로 제공.
 * realtime(RealtimeManager)·openLog는 안정적인 동작을 위임받는다.
 */
export interface RealtimeDeps {
	app: App;
	settings(): CoVaultSettings;
	realtime(): RealtimeManager;
	openLog(): Promise<void>;
}

/**
 * 실시간(Yjs) 도메인 컨트롤러 — 공간/개인 mirror 서명 토큰 발급·회수 + 상태 진단.
 * main.ts에서 분리(동작 불변). 토큰 값은 settings(sp.token / member.realtimeToken)에 기록한다.
 */
export class RealtimeController {
	constructor(private d: RealtimeDeps) {}

	/** 토큰 만료(epoch sec). TTL 미설정(0)이면 무만료. */
	private ttl(s: CoVaultSettings): number | undefined {
		return s.yjsTokenTtlDays && s.yjsTokenTtlDays > 0 ? Math.floor(Date.now() / 1000) + s.yjsTokenTtlDays * 86400 : undefined;
	}

	/**
	 * 모든 실시간 서명 토큰 재발급/회수(교사). 전역 실시간 + 시크릿이 있으면 모든 공유 공간과 개인 mirror에
	 * 발급하고, 꺼져 있거나 시크릿이 없으면 모두 비운다(stale 재배포 방지). 시크릿은 Secret Storage에서 읽는다.
	 *
	 * sp.token은 **교사 본인용**(r=manager) 토큰이다. 구성원용 토큰은 멤버별 클레임이 들어가므로
	 * 설정에 저장하지 않고 shares 배포 시 mintMemberToken으로 그때그때 발급한다.
	 */
	async mintAll(): Promise<void> {
		const s = this.d.settings();
		const yjsSecret = getYjsSecret(this.d.app, s.yjsSecret);
		const on = s.realtimeEnabled && !!yjsSecret;
		const ttl = this.ttl(s);
		for (const sp of s.sharedSpaces) {
			if (on)
				sp.token = await mintSpaceToken(yjsSecret, {
					workspaceId: s.workspaceId,
					spaceId: sp.id,
					remoteDb: sp.remoteDb || `share_${sp.id}`,
					memberId: s.userId,
					role: "manager",
					exp: ttl,
				});
			else delete sp.token;
		}
		for (const st of s.members) await this.mintMirror(st);
	}

	/**
	 * 공유 공간의 구성원용 토큰 발급(교사 → shares 배포 시 호출). 멤버별 m/r 클레임이 들어가
	 * 서버가 파일 단위 인가(rtpart)를 그 구성원 기준으로 수행한다. 발급 불가 조건이면 undefined.
	 */
	async mintMemberToken(space: SharedSpace, memberId: string): Promise<string | undefined> {
		const s = this.d.settings();
		const yjsSecret = getYjsSecret(this.d.app, s.yjsSecret);
		if (!s.realtimeEnabled || !yjsSecret || !memberId) return undefined;
		return mintSpaceToken(yjsSecret, {
			workspaceId: s.workspaceId,
			spaceId: space.id,
			remoteDb: space.remoteDb || `share_${space.id}`,
			memberId,
			role: "member",
			exp: this.ttl(s),
		});
	}

	/**
	 * 개인 mirror 실시간 토큰 발급/회수(교사). 전역 실시간 + yjsSecret 있을 때 발급, 아니면 비운다.
	 * spaceId=mirror-<memberId>이라 서버의 share 룸 prefix(<workspaceId>/share/<spaceId>/) 검증을 통과한다.
	 * mirror 룸은 1:1(교사+구성원)이라 서버가 rtpart 인가를 건너뛰므로, 교사도 이 토큰을 함께 쓴다.
	 */
	async mintMirror(member: MemberConfig): Promise<void> {
		const s = this.d.settings();
		const yjsSecret = getYjsSecret(this.d.app, s.yjsSecret);
		if (s.realtimeEnabled && yjsSecret && member.memberId && !member.realtimeBlocked) {
			member.realtimeToken = await mintSpaceToken(yjsSecret, {
				workspaceId: s.workspaceId,
				spaceId: `mirror-${member.memberId}`,
				remoteDb: member.remoteDb || `mirror_${member.memberId}`,
				memberId: member.memberId,
				role: "member",
				exp: this.ttl(s),
			});
		} else {
			delete member.realtimeToken;
		}
	}

	/** 실시간 진단(로그 패널로 상태 출력). */
	async realtimeStatus(): Promise<void> {
		await this.d.openLog();
		this.d.realtime().syncOpenEditors();
		this.d.realtime().diagnose();
	}
}

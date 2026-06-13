import { TFile } from "obsidian";
import { GroupConfig } from "../../settings/types";
import { ensureParentFolders } from "../../core/vault/folders";
import { errMessage } from "../../core/util/err";
import {
	MessageDoc,
	messageId,
	messagePrefix,
	CLASS_CHANNEL,
	groupChannel,
	parseGroupChannel,
	GroupDoc,
	chatGroupId,
	CHATGROUP_ID_PREFIX,
} from "../../core/model/types";
import { t } from "../../i18n";
import { ClassroomDeps } from "./deps";

/**
 * 대화(메신저) 도메인 — 학급/DM/그룹 채널 메시지, 첨부, 명명 그룹 대화방. 평가 P2-3: ClassroomController에서 분리(거동 불변).
 */
export class MessageController {
	constructor(private d: ClassroomDeps) {}

	// --- 채널 → pouch sync 해석 ---

	/** DM 채널의 대상 mirror sync 해석. 교사=대상 구성원 mirror, 학생=본인 mirror. */
	private dmSync(channel: string) {
		const s = this.d.settings();
		if (s.role === "manager") {
			const memberId = channel.slice("dm:".length);
			const member = s.members.find((m) => m.memberId === memberId);
			return member ? this.d.memberSyncByRemoteDb(member.remoteDb) : undefined;
		}
		return this.d.studentMirrorSync();
	}

	/** 그룹 채널의 공유 공간 sync 해석(채널에 remoteDb 인코딩됨). */
	private groupSync(channel: string) {
		const g = parseGroupChannel(channel);
		return g ? this.d.memberSyncByRemoteDb(g.remoteDb) : undefined;
	}

	/** class 외 채널(dm/group)의 pouch sync 해석. */
	private channelSync(channel: string) {
		return channel.startsWith("group:") ? this.groupSync(channel) : this.dmSync(channel);
	}

	/** 메시지 전송. 학급 채널=학급 공유 DB, DM=대상/본인 mirror DB. replyTo=답글 대상 _id. */
	async sendMessage(channel: string, body: string, replyTo?: string): Promise<boolean> {
		const s = this.d.settings();
		const text = body.trim();
		if (!text) return false;
		const uid = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
		const doc: MessageDoc = {
			_id: messageId(channel, uid),
			type: "message",
			schemaVersion: 1,
			workspaceId: s.workspaceId,
			channel,
			body: text,
			byUser: s.userId,
			byName: s.displayName || s.userId,
			byRole: s.role,
			...(replyTo ? { replyTo } : {}),
			createdAtMs: Date.now(),
		};
		if (channel === CLASS_CHANNEL) return this.d.classroom.put(doc);
		const sync = this.channelSync(channel);
		if (!sync) return false;
		await sync.ctx.pouch.put(doc);
		return true;
	}

	/**
	 * 채널 메시지 목록(오래된→최신). limit 지정 시 **최근 limit건만** 조회한다(평가 P-2) —
	 * 채널이 수천 건으로 자라도 폴링·렌더 비용이 창 크기로 유계. 미지정이면 전체(내보내기 등).
	 */
	async listMessages(channel: string, limit?: number): Promise<MessageDoc[]> {
		let docs: MessageDoc[];
		const prefix = messagePrefix(channel);
		if (channel === CLASS_CHANNEL) {
			docs = limit
				? await this.d.classroom.listRecentByPrefix<MessageDoc>(prefix, limit)
				: await this.d.classroom.listByPrefix<MessageDoc>(prefix);
		} else {
			const sync = this.channelSync(channel);
			// 이 채널의 정확한 prefix(message:dm:<id>: / message:group:<db>:<path>:)로 조회. 교사·학생이 같은
			// channel을 쓰므로 양쪽 일치. (이전엔 messagePrefix("dm:")가 "message:dm::"를 만들어 매칭 실패했다.)
			docs = !sync
				? []
				: limit
					? await sync.ctx.pouch.recentDocsByPrefix<MessageDoc>(prefix, limit)
					: await sync.ctx.pouch.allDocsByPrefix<MessageDoc>(prefix);
		}
		// recent 경로는 이미 deleted 제외·시간순이지만, 동일 ms 내 순서 보정을 위해 정렬은 유지(≤limit건이라 저렴).
		return docs.filter((d) => !d.deleted).sort((a, b) => a.createdAtMs - b.createdAtMs);
	}

	/** 채널의 첨부 폴더(전체=<홈 공간>/<첨부 폴더>, DM=대상/본인 폴더 아래). 정할 수 없으면 null. */
	private channelAttachDir(channel: string): string | null {
		const ATTACH = t("chat.attach_folder"); // 로케일 반영(평가 U-2). 기존 첨부는 메시지에 경로가 저장되어 불변.
		if (channel === CLASS_CHANNEL) {
			const home = this.d.homeroomFolder();
			return home ? `${home}/${ATTACH}` : null;
		}
		if (channel.startsWith("group:")) {
			const sync = this.groupSync(channel); // 공유 공간 폴더(localRoot) 아래
			return sync ? [sync.ctx.localRoot, ATTACH].filter(Boolean).join("/") : null;
		}
		const s = this.d.settings();
		if (s.role === "manager") {
			const memberId = channel.slice("dm:".length);
			const member = s.members.find((m) => m.memberId === memberId);
			return member ? [member.localRoot, ATTACH].filter(Boolean).join("/") : null;
		}
		return [s.localRoot, ATTACH].filter(Boolean).join("/");
	}

	/**
	 * vault 파일을 채널 첨부 폴더로 복사하고, 메시지에 넣을 임베드/링크 마크다운을 반환(실패 시 null).
	 * 복사본은 해당 채널 동기화 링크로 상대에게 전달된다(상대가 실제 파일을 받음).
	 */
	async attachFileToChannel(channel: string, srcPath: string): Promise<string | null> {
		const f = this.d.app.vault.getAbstractFileByPath(srcPath);
		if (!(f instanceof TFile)) return null;
		const maxMb = this.d.settings().maxAttachmentMB ?? 0;
		if (maxMb > 0 && f.stat.size > maxMb * 1024 * 1024) {
			this.d.logger.warn(t("chat.attach_too_large", { mb: maxMb }), true);
			return null;
		}
		const dir = this.channelAttachDir(channel);
		if (!dir) {
			this.d.logger.warn(t("chat.attach_unavailable"), true);
			return null;
		}
		const destName = `${Date.now().toString(36)}-${f.name}`;
		const destPath = `${dir}/${destName}`;
		try {
			await ensureParentFolders(this.d.app, destPath);
			const bytes = await this.d.app.vault.readBinary(f);
			await this.d.app.vault.createBinary(destPath, bytes);
		} catch (e) {
			this.d.logger.error(t("chat.attach_failed", { err: errMessage(e) }), true);
			return null;
		}
		const isImg = /\.(png|jpe?g|gif|webp|svg|bmp)$/i.test(f.name);
		return isImg ? `![[${destName}]]` : `[[${destName}]]`;
	}

	/** 메시지 삭제(soft-delete). 본인 메시지만 호출되도록 UI가 게이트. */
	async deleteMessage(channel: string, doc: MessageDoc): Promise<void> {
		const dead = { ...doc, deleted: true };
		if (channel === CLASS_CHANNEL) {
			await this.d.classroom.put(dead);
			return;
		}
		const sync = this.channelSync(channel);
		if (sync) await sync.ctx.pouch.put(dead);
	}

	// --- 명명 그룹 대화방 ---

	/** 명명 그룹의 대화 채널(homeroom 기반). homeroom 미지정이면 null. */
	groupChannelFor(groupId: string): string | null {
		const db = this.d.homeroomDb();
		return db ? groupChannel(db, groupId) : null;
	}

	/** 명명 그룹 문서(대화방)를 homeroom DB에 생성/갱신(교사). 학생은 동기화로 수신해 채널·멘션에 사용. */
	async syncGroupDoc(group: GroupConfig, memberNames: Record<string, string>): Promise<void> {
		const s = this.d.settings();
		if (s.role !== "manager") return;
		if (!this.d.homeroomReady()) {
			this.d.logger.warn(t("chat.group_needs_homeroom"), true);
			return;
		}
		const existing = await this.d.classroom.get<GroupDoc>(chatGroupId(group.id)).catch(() => null);
		await this.d.classroom.put({
			...(existing ?? {}),
			_id: chatGroupId(group.id),
			type: "chatgroup",
			schemaVersion: 1,
			workspaceId: s.workspaceId,
			groupId: group.id,
			name: group.name,
			memberIds: group.memberIds,
			memberNames,
			temp: !!group.temp,
			createdAtMs: existing?.createdAtMs ?? Date.now(),
			createdBy: existing?.createdBy ?? s.userId,
			deleted: false,
		} as GroupDoc);
	}

	/** 그룹 대화방 삭제(soft-delete). 그룹 삭제 시 호출 → 채널이 사라진다. */
	async deleteGroupDoc(groupId: string): Promise<void> {
		if (this.d.settings().role !== "manager") return;
		const existing = await this.d.classroom.get<GroupDoc>(chatGroupId(groupId)).catch(() => null);
		if (existing && !existing.deleted) await this.d.classroom.put({ ...existing, deleted: true } as GroupDoc);
	}

	/** 접근 가능한 그룹 대화방 목록(homeroom). 교사=전부, 구성원=자신이 속한 것만. */
	async listChatGroups(): Promise<Array<{ channel: string; groupId: string; name: string; memberIds: string[]; memberNames?: Record<string, string>; temp?: boolean }>> {
		const s = this.d.settings();
		const db = this.d.homeroomDb();
		if (!db) return [];
		const docs = await this.d.classroom.listByPrefix<GroupDoc>(CHATGROUP_ID_PREFIX);
		const out: Array<{ channel: string; groupId: string; name: string; memberIds: string[]; memberNames?: Record<string, string>; temp?: boolean }> = [];
		for (const g of docs) {
			if (!g || g.deleted || !g.groupId || !Array.isArray(g.memberIds)) continue; // groupId 없으면 레거시(파일별) → 제외
			if (s.role !== "manager" && !g.memberIds.includes(s.userId)) continue;
			out.push({ channel: groupChannel(db, g.groupId), groupId: g.groupId, name: g.name, memberIds: g.memberIds, memberNames: g.memberNames, temp: g.temp });
		}
		return out;
	}

	/** 레거시(0.100.x 파일별) 그룹 문서 정리(교사). groupId 없는 문서를 soft-delete해 드롭다운에서 제거. */
	async cleanupLegacyGroups(): Promise<void> {
		if (this.d.settings().role !== "manager" || !this.d.homeroomReady()) return;
		const docs = await this.d.classroom.listByPrefix<GroupDoc>(CHATGROUP_ID_PREFIX);
		for (const g of docs) {
			if (g && !g.deleted && !g.groupId) await this.d.classroom.put({ ...g, deleted: true } as GroupDoc);
		}
	}
}

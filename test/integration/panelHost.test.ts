// buildPanelHost(M-12 컴포지션)의 핵심 불변식 검증:
// 1) settings는 라이브 getter — load/import에서 객체가 교체되면 host.settings도 즉시 추종해야 한다.
// 2) pick으로 묶인 컨트롤러 메서드는 this 바인딩이 유지되어야 한다.
import { describe, it, expect } from "vitest";
import { buildPanelHost, PanelHostDeps, PanelNavigator } from "../../src/panelHost";
import { CoVaultSettings, DEFAULT_SETTINGS } from "../../src/settings/types";

/** 컨트롤러 더블 — pick이 읽는 이름의 메서드만 갖춘 객체(런타임엔 그걸로 충분). */
function fakeCtl(methods: Record<string, (...a: unknown[]) => unknown>): never {
	return methods as never;
}

function makeDeps(settingsRef: { current: CoVaultSettings }, calls: string[]): PanelHostDeps {
	// NoticeController 더블 — pick의 .bind(src)가 this를 유지하는지 검증(평가 P2-3 분할 후).
	class NoticeCtl {
		tag = "classroom-this";
		newNotice() {
			// pick의 .bind(src) 검증 — this가 끊기면 tag가 없다.
			calls.push(`newNotice:${(this as { tag?: string }).tag}`);
			return Promise.resolve(true);
		}
	}
	const noticeCtl = Object.assign(new NoticeCtl(), {
		// PanelHost 멤버를 채우기 위한 나머지 더미들(호출 안 함)
	});
	const noop = () => Promise.resolve() as never;
	return {
		app: {} as never,
		logger: {} as never,
		nav: new PanelNavigator({ workspace: { getLeavesOfType: () => [] } } as never),
		feedback: {} as never,
		classroom: {} as never,
		settings: () => settingsRef.current,
		noticeCtl: noticeCtl as never,
		assignmentCtl: fakeCtl({}),
		routineCtl: fakeCtl({}),
		messageCtl: fakeCtl({}),
		participantCtl: fakeCtl({}),
		recoveryCtl: fakeCtl({}),
		groupRequestCtl: fakeCtl({}),
		deploymentCtl: fakeCtl({}),
		realtimeCtl: fakeCtl({}),
		serverResetCtl: fakeCtl({}),
		memberCtl: fakeCtl({}),
		homeroomReady: () => true,
		homeroomConfigured: () => true,
		saveSettings: noop,
		openSettings: () => {},
		completeOnboarding: noop,
		fullSync: noop,
		toggleAutoSync: noop,
		refreshShares: noop,
		runDiagnostics: noop,
		openResetModal: () => {},
	};
}

describe("buildPanelHost (M-12)", () => {
	it("settings는 라이브 getter — deps의 settings 객체 교체를 즉시 추종한다", () => {
		const ref = { current: { ...DEFAULT_SETTINGS, workspaceId: "before" } as CoVaultSettings };
		const host = buildPanelHost(makeDeps(ref, []));
		expect(host.settings.workspaceId).toBe("before");
		// load/import가 settings 객체를 통째로 교체하는 상황
		ref.current = { ...DEFAULT_SETTINGS, workspaceId: "after" } as CoVaultSettings;
		expect(host.settings.workspaceId).toBe("after");
	});

	it("pick으로 묶인 컨트롤러 메서드는 this 바인딩이 유지된다", async () => {
		const calls: string[] = [];
		const ref = { current: { ...DEFAULT_SETTINGS } as CoVaultSettings };
		const host = buildPanelHost(makeDeps(ref, calls));
		await host.newNotice();
		expect(calls).toEqual(["newNotice:classroom-this"]);
	});
});

import { Awareness } from "y-protocols/awareness";
import { clientColor } from "./clientColor";

/**
 * 실시간 참가자 이름 칩(컨테이너 우하단 상시 표시). awareness의 다른 참가자 이름을 보여준다.
 * 마우스/터치 포인터와 무관하게 항상 보이며, 색은 Excalidraw와 동일한 clientColor(clientId) 공식을 쓴다.
 * markdown(CM6)·Excalidraw 양쪽에서 공유.
 */
export class PresenceChips {
	private el: HTMLElement;
	private handler: () => void;

	constructor(container: HTMLElement, private awareness: Awareness) {
		this.el = container.createDiv({ cls: "covault-presence" });
		this.handler = () => this.render();
		this.awareness.on("change", this.handler);
		this.render();
	}

	private render(): void {
		this.el.empty();
		let count = 0;
		this.awareness.getStates().forEach((state: any, clientId: number) => {
			if (clientId === this.awareness.clientID) return; // 자기 자신 제외
			const user = state?.user;
			if (!user) return;
			const chip = this.el.createDiv({ cls: "covault-presence-chip" });
			const dot = chip.createSpan({ cls: "covault-presence-dot" });
			dot.style.backgroundColor = clientColor(String(clientId));
			chip.createSpan({ text: (user.name as string) || "?" });
			count++;
		});
		this.el.toggleClass("is-empty", count === 0);
	}

	destroy(): void {
		this.awareness.off("change", this.handler);
		this.el.remove();
	}
}

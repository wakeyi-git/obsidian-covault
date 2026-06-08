/**
 * 패널 섹션이 재렌더(container.empty 후 재구성)할 때 스크롤이 최상단으로 튀지 않도록 위치를 보존한다.
 * 실제로 스크롤되는 가장 가까운 조상(대시보드는 .covault-dashboard, 그 외는 .covault-panel-body 등)을
 * 자동으로 찾아 그 scrollTop을 저장·복원한다.
 *
 * 사용: reload 시작에서 const restore = captureScroll(this.container); ... 재구성 ...; restore();
 */
function findScroller(el: HTMLElement | null): HTMLElement | null {
	let cur: HTMLElement | null = el;
	while (cur) {
		const oy = getComputedStyle(cur).overflowY;
		if ((oy === "auto" || oy === "scroll") && cur.scrollHeight - cur.clientHeight > 1) return cur;
		cur = cur.parentElement;
	}
	return null;
}

/** 현재 스크롤 위치를 캡처하고, 재구성 후 호출하면 복원하는 함수를 반환한다(변화 없으면 무동작). */
export function captureScroll(el: HTMLElement | null): () => void {
	const scroller = findScroller(el);
	const top = scroller?.scrollTop ?? 0;
	return () => {
		if (!scroller || top <= 0) return;
		scroller.scrollTop = top;
		// 재렌더 직후 레이아웃 확정이 늦는 경우 대비해 다음 프레임에 한 번 더 복원.
		window.requestAnimationFrame(() => {
			scroller.scrollTop = top;
		});
	};
}

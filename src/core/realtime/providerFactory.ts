import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";
import { HocuspocusProvider, HocuspocusProviderWebsocket } from "@hocuspocus/provider";

/**
 * 실시간 provider/소켓 생성 seam(평가 P2-1 — RealtimeManager에서 추출).
 *
 * RealtimeManager는 Hocuspocus 구상 클래스 대신 이 인터페이스만 의존한다 → 세션 수명주기·백오프·
 * 스냅샷 폴백을 fake provider로 단위 테스트할 수 있다(실 WebSocket 불필요). 기본 구현은 실제
 * Hocuspocus를 그대로 감싸므로 런타임 거동은 불변이다.
 */

/** 공유 WebSocket(모든 문서 멀티플렉싱) 추상. 매니저는 status 조회·destroy만 쓴다. */
export interface RealtimeSocket {
	readonly status: string;
	destroy(): void;
}

/** 문서별 provider 추상. 매니저는 attach/destroy/isAuthenticated만 쓴다. */
export interface RealtimeProvider {
	readonly isAuthenticated: boolean;
	attach(): void;
	destroy(): void;
}

/** provider 생성 설정 — startSession이 채워 넘긴다. */
export interface ProviderConfig {
	socket: RealtimeSocket;
	/** room 이름(서버 문서 키). */
	name: string;
	document: Y.Doc;
	awareness: Awareness;
	/** 공간별 HMAC 토큰(연결 후 인증 메시지로 전달). */
	token: string;
	onAuthenticated: () => void;
	onAuthenticationFailed: (payload: { reason?: unknown }) => void;
	onClose: (payload: { event?: { reason?: string } }) => void;
	onSynced: () => void;
}

/** 소켓·provider 팩토리. 기본 구현은 실제 Hocuspocus, 테스트는 fake 주입. */
export interface ProviderFactory {
	createSocket(url: string): RealtimeSocket;
	createProvider(config: ProviderConfig): RealtimeProvider;
}

/** 실제 Hocuspocus를 감싸는 기본 팩토리(런타임 거동 불변). */
export class HocuspocusProviderFactory implements ProviderFactory {
	createSocket(url: string): RealtimeSocket {
		return new HocuspocusProviderWebsocket({ url }) as unknown as RealtimeSocket;
	}

	createProvider(config: ProviderConfig): RealtimeProvider {
		// 기본 팩토리는 createSocket이 만든 실제 소켓을 받으므로 구상 타입으로 되돌릴 수 있다.
		const provider = new HocuspocusProvider({
			websocketProvider: config.socket as unknown as HocuspocusProviderWebsocket,
			name: config.name,
			document: config.document,
			awareness: config.awareness,
			// 토큰은 연결 후 인증 메시지로 전달된다(URL 쿼리 아님) → 리버스 프록시 로그에 남지 않는다.
			token: config.token,
			onAuthenticated: config.onAuthenticated,
			onAuthenticationFailed: ({ reason }) => config.onAuthenticationFailed({ reason }),
			onClose: ({ event }) => config.onClose({ event: event as { reason?: string } | undefined }),
			onSynced: config.onSynced,
		});
		return provider as unknown as RealtimeProvider;
	}
}

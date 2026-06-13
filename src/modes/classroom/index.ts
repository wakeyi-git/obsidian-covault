import { ClassroomDeps } from "./deps";
import { NoticeController } from "./NoticeController";
import { AssignmentController } from "./AssignmentController";
import { RoutineController } from "./RoutineController";
import { MessageController } from "./MessageController";

export type { ClassroomDeps } from "./deps";
export { NoticeController } from "./NoticeController";
export { AssignmentController } from "./AssignmentController";
export { RoutineController } from "./RoutineController";
export { MessageController } from "./MessageController";

/** 학급 운영 도메인 컨트롤러 4종 묶음(ClassroomController 분할 — 평가 P2-3). 키는 PanelHostDeps와 1:1. */
export interface ClassroomControllers {
	noticeCtl: NoticeController;
	assignmentCtl: AssignmentController;
	routineCtl: RoutineController;
	messageCtl: MessageController;
}

/** 동일 deps로 4개 컨트롤러를 생성해 묶음으로 반환(main 배선을 한 줄로 — 컴포지션 루트 비대화 방지). */
export function buildClassroomControllers(deps: ClassroomDeps): ClassroomControllers {
	return {
		noticeCtl: new NoticeController(deps),
		assignmentCtl: new AssignmentController(deps),
		routineCtl: new RoutineController(deps),
		messageCtl: new MessageController(deps),
	};
}

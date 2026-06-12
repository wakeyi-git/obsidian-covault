# node:22 — @hocuspocus/server v4가 Node >=22를 요구한다. alpine(musl) 대신 bookworm(glibc) 사용.
# better-sqlite3는 프리빌드가 없는 환경(일부 NAS)에서 소스 컴파일로 폴백하므로,
# 빌드 도구(python3/make/g++)를 설치해 npm install 후 같은 레이어에서 제거한다(이미지 크기 유지).
FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json ./
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && npm install --omit=dev \
 && apt-get purge -y python3 make g++ \
 && apt-get autoremove -y \
 && rm -rf /var/lib/apt/lists/*
# 서버 소스 전체(*.js) — 파일을 명시 나열하면 새 모듈 추가 시 누락된다(0.121.0 docLifecycle.js 사고).
COPY *.js ./
ENV HOST=0.0.0.0 PORT=1234 SQLITE_PATH=/data/hocuspocus.sqlite
EXPOSE 1234
CMD ["node", "server.js"]

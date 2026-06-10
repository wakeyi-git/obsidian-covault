# better-sqlite3(네이티브 모듈) prebuild가 glibc 기준이라 alpine(musl) 대신 bookworm-slim을 쓴다.
# prebuild가 없는 아키텍처(일부 arm NAS)에서 빌드가 실패하면 아래 build-deps 줄의 주석을 푸세요.
FROM node:20-bookworm-slim
WORKDIR /app
# RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json ./
RUN npm install --omit=dev
COPY server.js auth.js couch.js ./
ENV HOST=0.0.0.0 PORT=1234 SQLITE_PATH=/data/hocuspocus.sqlite
EXPOSE 1234
CMD ["node", "server.js"]

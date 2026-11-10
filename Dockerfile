# 对位 · AI 智能筛选 JD（零依赖，无 npm install / 无构建）
FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production \
    PORT=8790

# curl：猎聘对 Node TLS 指纹返回挑战页，用 curl 抓；poppler：PDF 简历抽文本
RUN apk add --no-cache curl poppler-utils

COPY package.json server.js ./
COPY lib ./lib
COPY web ./web

RUN mkdir -p /app/data && chown -R node:node /app
USER node

EXPOSE 8790
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8790/api/health || exit 1

CMD ["node", "server.js"]

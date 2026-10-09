# ---------- 构建阶段 ----------
FROM node:20-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---------- 运行阶段 ----------
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY --from=build /app/dist ./dist
# drizzle 迁移 SQL（启动时由 dist/db/migrate.js 程序化执行，必须随镜像分发）
COPY drizzle ./drizzle
RUN mkdir -p data/uploads data/processed
EXPOSE 3001
CMD ["node", "dist/index.js"]

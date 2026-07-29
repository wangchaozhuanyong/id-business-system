FROM node:24-alpine AS build

WORKDIR /app

COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/admin/package.json apps/admin/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN npm ci

COPY . .
ARG VITE_API_BASE_URL=/api
ARG VITE_APP_TITLE="ID 业务管理系统"
ENV VITE_API_BASE_URL=${VITE_API_BASE_URL}
ENV VITE_APP_TITLE=${VITE_APP_TITLE}
RUN npm run build --workspace @apple-business/shared
RUN npm exec --workspace @apple-business/admin -- vite build

FROM nginx:1.27-alpine AS runtime

COPY deploy/nginx/admin.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/admin/dist /usr/share/nginx/html

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1/ >/dev/null || exit 1

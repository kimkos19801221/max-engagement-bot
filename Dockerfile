FROM node:22-alpine AS deps

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

FROM node:22-alpine AS runner

WORKDIR /app
ENV NODE_ENV=production
ENV ADMIN_HOST=0.0.0.0
ENV ADMIN_PORT=4317

COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json tsconfig.json ./
COPY src ./src

EXPOSE 4317

HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=8 \
  CMD wget -qO- http://127.0.0.1:4317/healthz || exit 1

CMD ["npm", "run", "web"]

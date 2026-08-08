FROM node:22-alpine AS deps

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

FROM node:22-alpine AS runner

WORKDIR /app
ENV NODE_ENV=production
ENV ADMIN_HOST=0.0.0.0
ENV ADMIN_PORT=3000

RUN apk add --no-cache curl

COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json tsconfig.json ./
COPY src ./src

EXPOSE 3000

CMD ["npm", "run", "timeweb"]

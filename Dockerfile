FROM node:22-alpine AS deps

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

FROM node:22-alpine AS runner

WORKDIR /app
ENV NODE_ENV=production
ENV ADMIN_HOST=0.0.0.0
ENV ADMIN_PORT=3000

COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json tsconfig.json ./
COPY src ./src

EXPOSE 3000

HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=8 \
  CMD node -e "const req=require('node:http').request({host:'127.0.0.1',port:3000,path:'/healthz',method:'HEAD',timeout:3000},res=>{res.resume();process.exit(res.statusCode===200?0:1)});req.on('timeout',()=>{req.destroy();process.exit(1)});req.on('error',()=>process.exit(1));req.end()"

CMD ["npm", "run", "web"]

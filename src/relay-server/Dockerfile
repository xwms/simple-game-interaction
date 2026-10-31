FROM node:22-alpine AS build
WORKDIR /app
RUN npm config set registry https://registry.npmmirror.com
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npx tsc --project tsconfig.json

FROM node:22-alpine AS runtime
WORKDIR /app
RUN apk add --no-cache netcat-openbsd && addgroup -S relay && adduser -S relay -G relay
COPY --from=build /app/dist/relay-server ./dist
COPY package.json package-lock.json ./
RUN npm config set registry https://registry.npmmirror.com && npm ci --omit=dev && npm cache clean --force
USER relay
EXPOSE 9800 9801
ENV NODE_ENV=production
CMD ["node", "dist/main.js"]

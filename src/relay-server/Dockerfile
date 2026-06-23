FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.relay-server.json ./
COPY src/relay-server ./src/relay-server
RUN npx tsc --project tsconfig.relay-server.json

FROM node:22-alpine AS runtime
WORKDIR /app
RUN addgroup -S relay && adduser -S relay -G relay
COPY --from=build /app/dist/relay-server ./dist
COPY package.json ./
RUN npm install --omit=dev && npm cache clean --force
USER relay
EXPOSE 9800 9801
ENV NODE_ENV=production
CMD ["node", "dist/main.js"]

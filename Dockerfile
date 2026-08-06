FROM node:24.18.1-bookworm-slim AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY babel.config.json webpack.config.cjs ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:24.18.1-bookworm-slim

WORKDIR /app

ENV NODE_ENV=production

COPY --from=build --chown=node:node /app/package.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/src ./src

USER node

CMD ["npm", "start"]

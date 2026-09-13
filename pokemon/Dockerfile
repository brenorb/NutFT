FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY pokemon-napplet/package.json pokemon-napplet/pnpm-lock.yaml pokemon-napplet/
RUN corepack enable && corepack prepare pnpm@10.8.0 --activate && pnpm --dir pokemon-napplet install --frozen-lockfile
COPY . .
RUN npm run build:pokemon

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production POKEMON_HOST=0.0.0.0 POKEMON_PORT=8080
COPY --from=build /app .
RUN mkdir -p /app/.pokemon-state
EXPOSE 8080
CMD ["node", "server/pokemon.js"]

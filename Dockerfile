# ─── Nexo Assist — imagem única (API + build do front) ───────────────────────
# A API serve a SPA de apps/web/dist em produção e expõe as rotas sob /api.
# Build:   docker build -t nexo-assist .
# Run:     docker run -p 4100:4100 -e OPENAI_API_KEY=... nexo-assist
# Sem chave LLM o engine cai no modo "scripted" (demo funcional offline).

FROM node:22-alpine AS build
WORKDIR /app

# manifestos primeiro → cache de deps
COPY package.json package-lock.json tsconfig.base.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci

COPY apps ./apps
RUN npm run build

# ─── runtime ─────────────────────────────────────────────────────────────────
FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci --omit=dev

COPY --from=build /app/apps/api/dist ./apps/api/dist
COPY --from=build /app/apps/web/dist ./apps/web/dist

ENV PORT=4100
EXPOSE 4100
# DATABASE_FILE padrão: apps/api/data/nexo.db — monte um volume para persistir
WORKDIR /app/apps/api
CMD ["node", "dist/index.js"]

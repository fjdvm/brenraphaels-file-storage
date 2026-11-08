# Runs the TypeScript source directly: Node 24 strips types, the same way `npm run dev` does.
FROM node:24-slim

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src
COPY docs/guide ./docs/guide

USER node
ENV PORT=3000
EXPOSE 3000
CMD ["node", "src/server.ts"]

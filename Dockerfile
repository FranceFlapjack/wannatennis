# Wanna Tennis ? — one small always-on container. No npm install: zero dependencies.
# node:sqlite needs Node 22.5+.
FROM node:22-slim
WORKDIR /app
COPY . .
ENV NODE_ENV=production PORT=3000
EXPOSE 3000
# data/ (alerts db + latest snapshot) lives on a Fly volume mounted at /app/data
CMD ["node", "--disable-warning=ExperimentalWarning", "server.js"]

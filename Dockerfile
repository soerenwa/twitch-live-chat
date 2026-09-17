# Zero-dependency Node service — nothing to npm install.
FROM node:22-alpine

WORKDIR /app

# Only the files the service needs at runtime.
COPY package.json server.js twitch-chat.js twitch-chat.html ./

ENV PORT=8080 \
    BUFFER_SIZE=200 \
    MAX_CHANNELS=50 \
    IDLE_MS=60000 \
    NODE_ENV=production

EXPOSE 8080

# Drop root.
USER node

# Lightweight health check against the built-in endpoint.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "server.js"]

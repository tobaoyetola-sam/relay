FROM node:22-bookworm-slim

WORKDIR /app
ENV NODE_ENV=production
# Heap must sit well inside the container memory limit (512Mi), leaving room
# for buffers and native memory. 512 MB of heap in a 256Mi container is what
# got the pod OOM-killed instead of garbage-collecting.
ENV NODE_OPTIONS=--max-old-space-size=320

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# .dockerignore keeps .env out of the build context. The old `RUN rm -f .env`
# removed it from the final layer only; it was still readable in the COPY layer.
COPY src ./src

USER node
EXPOSE 8080

# node is PID 1 so it receives SIGTERM directly (sh + npm swallowed it).
CMD ["node", "src/server.js"]

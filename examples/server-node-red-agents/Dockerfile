FROM node:22.19.0-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /workspace
COPY --chown=node:node package.json package-lock.json ./
COPY --chown=node:node packages/ ./packages/
COPY --chown=node:node examples/ ./examples/
COPY --chown=node:node openapi.json ./openapi.json
RUN npm ci
RUN mkdir -p /workspace-data /data/projects /data/agent-work && chown -R node:node /workspace-data /data
USER node
EXPOSE 3094
CMD ["npm", "run", "start:node-red-agents"]

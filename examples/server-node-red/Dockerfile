FROM node:22.19.0-bookworm-slim

WORKDIR /workspace
COPY --chown=node:node package.json package-lock.json ./
COPY --chown=node:node packages/ ./packages/
COPY --chown=node:node examples/ ./examples/
COPY --chown=node:node openapi.json ./openapi.json
RUN npm ci

USER node
EXPOSE 3093
CMD ["npm", "run", "start:node-red"]

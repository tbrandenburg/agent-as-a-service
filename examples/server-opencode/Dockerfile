FROM node:22.19.0-bookworm-slim

ENV OPENCODE_DIR=/workspace \
    OPENCODE_MODEL=opencode/big-pickle \
    HOST=0.0.0.0 \
    PORT=3092

WORKDIR /workspace
RUN npm install --global opencode-ai@1.18.33 \
    && chown node:node /workspace

COPY --chown=node:node package.json package-lock.json ./
COPY --chown=node:node packages/ ./packages/
COPY --chown=node:node examples/ ./examples/
COPY --chown=node:node openapi.json ./openapi.json

RUN npm ci

USER node
EXPOSE 3092
CMD ["npm", "run", "start:opencode"]

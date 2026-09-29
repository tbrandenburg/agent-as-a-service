FROM nodered/node-red:5.0.7
USER root
RUN npm install -g opencode-ai@1.18.33 --ignore-scripts=false
COPY --chown=node-red:node-red examples/server-node-red-agents/node-red/package.json examples/server-node-red-agents/node-red/package-lock.json /data/
WORKDIR /data
RUN npm ci --omit=dev
COPY --chown=node-red:node-red examples/server-node-red-agents/node-red/flows.json /data/flows.json
COPY --chown=node-red:node-red examples/server-node-red-agents/node-red/settings.js /data/settings.js
COPY --chown=node-red:node-red examples/server-node-red-agents/node-red/fixture/opencode /data/fixture/opencode
RUN chmod +x /data/fixture/opencode
RUN mkdir -p /data/agent-work && chown -R node-red:node-red /data
WORKDIR /usr/src/node-red
USER node-red
RUN opencode session list --format json > /dev/null

FROM nodered/node-red:5.0.7
USER root
RUN npm install -g opencode-ai@1.18.33 --ignore-scripts=false
COPY --chown=node-red:node-red examples/server-node-red-agents/node-red/package.json examples/server-node-red-agents/node-red/package-lock.json /data/
WORKDIR /data
RUN npm ci --omit=dev
COPY examples/server-node-red-agents/node-red/extract-link-caller.cjs /tmp/extract-link-caller.cjs
RUN node /tmp/extract-link-caller.cjs /seed
COPY packages/contract/src/v1/schemas/ /tmp/contract-schemas/
RUN NODE_PATH=/data/node_modules /data/node_modules/.bin/esbuild /tmp/contract-schemas/domain.ts --bundle --platform=node --format=cjs --outfile=/seed/run-output.cjs
COPY --chown=node-red:node-red examples/server-node-red-agents/node-red/cwd-list/ /data/node_modules/node-red-contrib-cwd-list-example/
COPY --chown=node-red:node-red examples/server-node-red-agents/node-red/settings.js /seed/settings.js
COPY --chown=node-red:node-red examples/server-node-red-agents/node-red/supervisor.js /seed/supervisor.js
COPY --chown=node-red:node-red examples/server-node-red-agents/node-red/worker-host.js examples/server-node-red-agents/node-red/observer.js examples/server-node-red-agents/node-red/interaction-host.js /seed/
RUN mkdir -p /data/agent-work /data/projects && chown -R node-red:node-red /data /seed
RUN rm -f /data/flows.json
WORKDIR /usr/src/node-red
USER node-red
RUN opencode session list --format json > /dev/null
ENTRYPOINT ["sh", "-c"]
CMD ["set -e; : \"${DEFAULT_MODEL:?DEFAULT_MODEL must not be empty}\"; umask 077; cp -R /home-seed/. \"$HOME\"/; mkdir -p /data/agent-work /data/projects; exec node /seed/supervisor.js"]

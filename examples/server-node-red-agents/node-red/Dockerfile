FROM nodered/node-red:5.0.7
USER root
RUN npm install -g opencode-ai@1.18.33 --ignore-scripts=false
COPY packages/node-red-host/ /opt/node-red-host/
RUN npm pack /opt/node-red-host --pack-destination /tmp \
    && npm install -g /tmp/tbrandenburg-node-red-host-0.1.0.tgz \
    && npm ls -g @tbrandenburg/node-red-host \
    && node --version \
    && node -p "require('/usr/src/node-red/node_modules/node-red/package.json').version + ' ' + require.resolve('/usr/src/node-red/node_modules/node-red')"
COPY --chown=node-red:node-red examples/server-node-red-agents/node-red/package.json examples/server-node-red-agents/node-red/package-lock.json /data/
WORKDIR /data
RUN npm ci --omit=dev
RUN npm ls @tbrandenburg/node-red-agents
COPY --chown=node-red:node-red examples/server-node-red-agents/node-red/cwd-list/ /data/node_modules/node-red-contrib-cwd-list-example/
RUN mkdir -p /data/agent-work /data/projects && chown -R node-red:node-red /data
RUN rm -f /data/flows.json
WORKDIR /usr/src/node-red
USER node-red
RUN opencode session list --format json > /dev/null
ENTRYPOINT ["sh", "-c"]
CMD ["set -e; : \"${DEFAULT_MODEL:?DEFAULT_MODEL must not be empty}\"; umask 077; cp -R /home-seed/. \"$HOME\"/; mkdir -p /data/agent-work /data/projects; exec aaas-node-red-host"]

# jotdrop-mcp as a container next to an agent (Hermes, OpenClaw) on a private Docker network.
# The connection (with the key to the notes) lives in the /data volume; the HTTP token comes from JOTDROP_MCP_TOKEN.
# Never publish the port to the internet: no "ports:" in compose, only the internal network.
#
#   docker build --build-arg JOTDROP_MCP_VERSION=0.1.0 -t jotdrop-mcp:0.1.0 .
#   docker compose run --rm jotdrop-mcp jotdrop-mcp connect --code <code from the app>
FROM node:26-alpine

ARG JOTDROP_MCP_VERSION=0.1.0
RUN npm install --global --no-fund --no-audit "jotdrop-mcp@${JOTDROP_MCP_VERSION}" && npm cache clean --force

ENV JOTDROP_MCP_HOME=/data NODE_ENV=production
RUN mkdir -p /data && chown node:node /data && chmod 700 /data
VOLUME /data
USER node

EXPOSE 8765
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD wget -qO- http://127.0.0.1:8765/healthz || exit 1
CMD ["jotdrop-mcp", "serve", "--http", "0.0.0.0:8765"]

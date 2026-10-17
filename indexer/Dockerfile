# Indexeur SEAL : aucune dépendance, Node 24 exécute le TypeScript directement.
FROM node:24-slim

ENV NODE_ENV=production \
    PORT=8795 \
    DB_PATH=/data/seal-indexer.db

WORKDIR /app
COPY package.json ./
COPY src ./src

# Utilisateur sans privilège, propriétaire du seul dossier où il écrit.
RUN groupadd --system seal \
    && useradd --system --gid seal --home-dir /app --shell /usr/sbin/nologin seal \
    && mkdir -p /data \
    && chown seal:seal /data
USER seal
VOLUME ["/data"]

EXPOSE 8795

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 8795) + '/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]

CMD ["node", "--disable-warning=ExperimentalWarning", "src/main.ts"]

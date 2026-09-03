#!/usr/bin/env bash

set -e

INNGEST_CONFIG=".config/inngest/inngest.yaml"

# Try to store Inngest data in Postgres if it's available. Otherwise, put it in SQLite.
if [[ ! -f  "${INNGEST_CONFIG}" ]]; then
    mkdir -p "$(dirname "${INNGEST_CONFIG}")"
    if [[ -n "${DATABASE_URL}" ]]; then
        printf 'postgres-uri: "%s"' "${DATABASE_URL}" > "${INNGEST_CONFIG}"
    else
        printf 'sqlite-dir: "/home/runner/workspace/.local/share/inngest"' > "${INNGEST_CONFIG}"
    fi
fi
exec inngest-cli dev -u <REDACTED_URL> --host <REDACTED_IP> --port 3000 --config "${INNGEST_CONFIG}"

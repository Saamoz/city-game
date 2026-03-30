#!/usr/bin/env bash
set -euo pipefail

if command -v docker >/dev/null 2>&1; then
  if docker info >/dev/null 2>&1; then
    exec docker compose "$@"
  fi
fi

if [ -x '/mnt/c/Program Files/Docker/Docker/resources/bin/docker.exe' ]; then
  exec '/mnt/c/Program Files/Docker/Docker/resources/bin/docker.exe' compose "$@"
fi

echo 'Docker CLI not found. Install Docker in WSL or enable Docker Desktop WSL integration.' >&2
exit 1

#!/usr/bin/env bash
# Import secrets securely into a GitHub repository using GitHub CLI.
# Usage: ./setup-secrets.sh YOUR_USERNAME/zu41-schedule-bot /path/to/zu41_private.env
set -euo pipefail
if [ "$#" -ne 2 ]; then
  echo 'Использование: ./setup-secrets.sh USERNAME/REPOSITORY /path/to/zu41_private.env'
  exit 2
fi
if ! command -v gh >/dev/null 2>&1; then
  echo 'Установи GitHub CLI: https://cli.github.com/'
  exit 2
fi
if [ ! -f "$2" ]; then
  echo 'Не найден файл с приватными ключами.'
  exit 2
fi
gh auth status >/dev/null || { echo 'Войди в GitHub через gh auth login'; exit 2; }
gh secret set --repo "$1" --env-file "$2"
echo 'Секреты отправлены в GitHub Secrets; их значения не попадали в git.'

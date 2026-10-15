#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
printf 'Absolute path to the parent of your project folder: '
IFS= read -r project_root
node scripts/install.mjs --root "$project_root"
printf '\nPress Return to close.'
IFS= read -r unused

#!/bin/zsh
cd "$(dirname "$0")"
if [ ! -d "LocalBrain.app" ]; then
  npm run build-app
fi
open "LocalBrain.app"

#!/bin/bash
# Double-click in Finder: starts the board and the agents, opens the browser.
cd "$(dirname "$0")" || exit 1
exec npm run up

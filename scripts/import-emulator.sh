#!/bin/bash

# Assumes that the emulator Git submodule has been fetched and it has been
# built.

ROOT_DIR="`dirname "${BASH_SOURCE[0]}"`/.."

if [ "$1" = "basiliskii" ]; then
    EMULATOR="BasiliskII"
    EMULATOR_DIR="${ROOT_DIR}/macemu/${EMULATOR}/src/Unix"
elif [ "$1" = "sheepshaver" ]; then
    EMULATOR="SheepShaver"
    EMULATOR_DIR="${ROOT_DIR}/macemu/${EMULATOR}/src/Unix"
elif [[ "$1" =~ ^minivmac- ]]; then
    EMULATOR=$1
    EMULATOR_DIR="${ROOT_DIR}/minivmac"
else
    echo "Unknown emulator $1"
    exit 1
fi

SRC_DIR="${ROOT_DIR}/src"
PUBLIC_DIR="${ROOT_DIR}/public"
EMULATOR_DESTINATION_DIR="${SRC_DIR}/emulator"

if [ ! -f "${EMULATOR_DIR}/${EMULATOR}.wasm" ]; then
    echo "${EMULATOR} has not been built. Refer to the README for details."
    exit
fi

# Build output
cp "${EMULATOR_DIR}/${EMULATOR}" "${EMULATOR_DESTINATION_DIR}/${EMULATOR}.jsz"
cp "${EMULATOR_DIR}/${EMULATOR}.wasm" "${EMULATOR_DESTINATION_DIR}/${EMULATOR}.wasmz"
# Source map needs massaging and needs to be put into the public directory (we
# don't control the URL that it's referenced under).
scripts/rewrite-emulator-source-map.py "${EMULATOR_DIR}/${EMULATOR}.wasm.map" "${PUBLIC_DIR}/${EMULATOR}.wasm.map"

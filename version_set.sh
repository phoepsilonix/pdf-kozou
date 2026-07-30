#!/bin/env bash

VERSION=$(jq -r '.version' package.json)

VERSION_PRE=${VERSION%.*}
VERSION_SUF=${VERSION##*.}
VERSION_SUF=$((${VERSION_SUF}+1))

NEW_VERSION=$(echo $VERSION_PRE.$VERSION_SUF)
[[ "$1" != "" ]] && NEW_VERSION=$1

echo $NEW_VERSION
sed -i -e "s/\"version\": \"[0-9.]*\",/\"version\": \"${NEW_VERSION}\",/" package.json 
sed -i -e "s/^version = \"[0-9.]*\"/version = \"${NEW_VERSION}\"/" src-tauri/Cargo.toml 
sed -i -e "s/^version = \"[0-9.]*\"/version = \"${NEW_VERSION}\"/" pdf-kozou-core/Cargo.toml 

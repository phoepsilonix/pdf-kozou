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
# iOS: Info.plist / project.yml のバージョンも連動させる
# (CFBundleShortVersionString / CFBundleVersion。App Store Connect 用にビルド番号も同値で更新)
IOS_DIR=src-tauri/gen/apple
sed -i -e "/<key>CFBundleShortVersionString<\/key>/{n;s|<string>[0-9.]*</string>|<string>${NEW_VERSION}</string>|}" \
       -e "/<key>CFBundleVersion<\/key>/{n;s|<string>[0-9.]*</string>|<string>${NEW_VERSION}</string>|}" \
       ${IOS_DIR}/pdf-kozou_iOS/Info.plist
sed -i -e "s/CFBundleShortVersionString: [0-9.]*/CFBundleShortVersionString: ${NEW_VERSION}/" \
       -e "s/CFBundleVersion: \"[0-9.]*\"/CFBundleVersion: \"${NEW_VERSION}\"/" \
       ${IOS_DIR}/project.yml

#!/bin/bash
# ClipSnap auto-detect hook — checks if clipboard has an image when user mentions screenshots
# Disabled by default (CLIPSNAP_AUTO_DETECT_HOOK=false)

# Check if auto-detect is enabled
if [ "${CLIPSNAP_AUTO_DETECT_HOOK}" != "true" ]; then
  echo '{"continue": true}'
  exit 0
fi

# Read hook input from stdin
input=$(cat)
prompt=$(echo "$input" | jq -r '.prompt // ""')

# Check for image-related keywords (ru + en)
if echo "$prompt" | grep -qiE '(скриншот|скрин|screenshot|image|картинк|фото|экран|снимок|paste|вставь)'; then
  # Check if clipboard actually has an image
  if command -v pngpaste &>/dev/null; then
    if pngpaste - >/dev/null 2>&1; then
      echo '{"additionalContext": "[ClipSnap] Clipboard contains an image. Use the paste_image tool from clipsnap to read it."}'
      exit 0
    fi
  fi
fi

echo '{"continue": true}'

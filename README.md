# OVH Cloud Sync for Obsidian

[![Release](https://img.shields.io/github/v/release/original-flipster69/obsidian-sync?style=flat-square)](https://github.com/original-flipster69/obsidian-sync/releases/latest)
[![License](https://img.shields.io/github/license/original-flipster69/obsidian-sync?style=flat-square)](LICENSE)
[![Build](https://img.shields.io/github/actions/workflow/status/original-flipster69/obsidian-sync/release.yml?style=flat-square)](https://github.com/original-flipster69/obsidian-sync/actions/workflows/release.yml)

Bidirectional sync plugin for Obsidian vaults using OVH Cloud Object Storage (S3-compatible).

## Features

- Full and incremental sync between your vault and OVH Object Storage
- Conflict detection with last-write-wins resolution
- Auto-sync on file changes with configurable debounce
- Scheduled full sync at a configurable interval
- Mass-deletion protection to prevent accidental wipes
- First-sync safety: download-only on new devices
- Works on both desktop and mobile

## Setup

1. Install the plugin in Obsidian
2. Open Settings > OVH Cloud Sync
3. Select your OVH region (or set a custom S3 endpoint)
4. Enter your S3 access key and secret key
5. Enter your bucket name
6. Click **Test** to verify the connection
7. Run your first sync via the ribbon icon or command palette

## Development

```sh
npm install
npm run dev    # watch mode
npm run build  # production build
```

## License

MIT

# OVH Cloud Sync for Obsidian

![GitHub License](https://img.shields.io/github/license/original-flipster69/obsidian-sync)
![GitHub Release](https://img.shields.io/github/v/release/original-flipster69/obsidian-sync)
![TypeScript](https://img.shields.io/badge/-TypeScript-grey?logo=typescript&logoColor=3178c6&labelColor=grey&color=3178c6)
![original.flipster](https://img.shields.io/badge/-original.flipster-grey?logo=data%3Aimage%2Fgif%3Bbase64%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&logoSize=auto&labelColor=grey&color=292524)

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

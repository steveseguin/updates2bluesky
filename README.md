# Bluesky JSON Feed Sync

This Cloudflare Worker automatically syncs updates from a JSON feed to a Bluesky account. It runs hourly and maintains chronological order of posts while preventing duplicates.

## Features

- 🕒 Runs automatically every hour via Cloudflare Workers
- 🔄 Syncs JSON feed entries to Bluesky posts
- 📸 Supports image attachments
- ⏱️ Maintains chronological posting order
- 🎯 Prevents duplicate posts using KV storage
- 💸 Runs on Cloudflare's generous free tier

## Prerequisites

- Node.js and npm installed
- A Cloudflare account
- A Bluesky account
- A JSON feed URL with the following structure:
```json
[
    {
        "content": "Post content",
        "timestamp": 1728147198.579464,
        "name": "username",
        "msgid": "unique_message_id",
        "attachments": [
            {
                "mime": "image/png",
                "url": "https://example.com/image.png",
                "desc": null
            }
        ]
    }
]
```

## Setup Instructions

1. **Install Wrangler CLI**
   ```bash
   npm install -g wrangler
   ```

2. **Login to Cloudflare**
   ```bash
   npx wrangler login
   ```

3. **Create a KV namespace**
   ```bash
   npx wrangler kv:namespace create "BLUESKY_SYNC_KV"
   ```
   Save the ID that is output for use in the next step.

4. **Create wrangler.toml configuration**
   Create a file named `wrangler.toml` with the following content:
   ```toml
   name = "bluesky-json-sync"
   main = "src/worker.js"
   compatibility_date = "2024-01-01"

   kv_namespaces = [
       { binding = "BLUESKY_SYNC_KV", id = "your-kv-namespace-id-from-step-3" }
   ]

   [triggers]
   crons = ["0 * * * *"]  # Runs at the start of every hour

   [vars]
   BLUESKY_USERNAME = "your-username.bsky.social"
   BLUESKY_PASSWORD = "your-password"
   JSON_SOURCE_URL = "https://your-json-url.com/feed.json"
   ```

5. **Deploy the Worker**
   ```bash
   npx wrangler deploy
   ```

## Monitoring and Maintenance

- View real-time logs:
  ```bash
  npx wrangler tail
  ```

- Test the worker manually:
  ```bash
  npx wrangler deployment-check bluesky-json-sync
  ```

## Customization

### Changing the Schedule
The default schedule runs hourly at minute 0. To modify this, adjust the cron pattern in `wrangler.toml`:
- Every 30 minutes: `crons = ["*/30 * * * *"]`
- Every 2 hours: `crons = ["0 */2 * * *"]`
- Daily at noon: `crons = ["0 12 * * *"]`

## Troubleshooting

1. If Wrangler isn't recognized after installation:
   - Close and reopen your terminal
   - Or use `npx wrangler` instead of `wrangler`

2. If posts appear out of order:
   - The worker includes a 2-second delay between posts to maintain chronological order
   - Check that your JSON feed timestamps are correct

3. If you see duplicate posts:
   - Check if the KV namespace is properly configured
   - Verify that message IDs are unique in your JSON feed

## Security Notes

- Store your Bluesky credentials securely
- Don't commit `wrangler.toml` with real credentials to public repositories
- Consider using Cloudflare's secret management for sensitive values

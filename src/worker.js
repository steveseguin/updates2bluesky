// wrangler.toml configuration:
//
// name = "bluesky-json-sync"
// main = "src/worker.js"
// compatibility_date = "2024-01-01"
//
// [triggers]
// crons = ["0 * * * *"]  # Runs hourly
//
// [vars]
// BLUESKY_USERNAME = "your-username.bsky.social"
// BLUESKY_PASSWORD = "your-password"
// JSON_SOURCE_URL = "https://your-json-url.com/feed.json"

export default {
  async fetch(request, env, ctx) {
    return new Response('Worker running!');
  },

  async scheduled(event, env, ctx) {
    const worker = new BlueskySync(env);
    await worker.sync();
  }
};

class BlueskySync {
  constructor(env) {
    this.env = env;
    this.apiUrl = 'https://bsky.social/xrpc/';
    this.accessJwt = null;
  }

  async sync() {
    try {
      // Login to Bluesky
      await this.login();
      
      // Fetch current state from KV store
      const postedMsgIds = await this.getPostedMsgIds();
      
      // Fetch and parse JSON feed
      const feed = await this.fetchJSONFeed();
      
      // Sort entries by timestamp (oldest first)
      const sortedEntries = feed.sort((a, b) => a.timestamp - b.timestamp);
      
      // Process entries in chronological order
      for (const entry of sortedEntries) {
        if (!postedMsgIds.includes(entry.msgid)) {
          await this.postToBluesky(entry);
          postedMsgIds.push(entry.msgid);
          
          // Add a small delay between posts to maintain order
          await new Promise(resolve => setTimeout(resolve, 2000));
          
          // Keep only last 1000 message IDs to manage storage
          if (postedMsgIds.length > 1000) {
            postedMsgIds.shift();
          }
        }
      }
      
      // Save updated state
      await this.savePostedMsgIds(postedMsgIds);
      
      return new Response('Sync completed successfully', { status: 200 });
    } catch (error) {
      console.error('Sync failed:', error);
      return new Response(`Sync failed: ${error.message}`, { status: 500 });
    }
  }

  async login() {
    const response = await fetch(`${this.apiUrl}com.atproto.server.createSession`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        identifier: this.env.BLUESKY_USERNAME,
        password: this.env.BLUESKY_PASSWORD
      })
    });

    if (!response.ok) {
      throw new Error('Failed to authenticate with Bluesky');
    }

    const data = await response.json();
    this.accessJwt = data.accessJwt;
  }

  async fetchJSONFeed() {
    const response = await fetch(this.env.JSON_SOURCE_URL);
    if (!response.ok) {
      throw new Error('Failed to fetch JSON feed');
    }
    return response.json();
  }

  async postToBluesky(entry) {
    const text = entry.content || '';
    let images = [];

    // Handle attachments if present
    if (entry.attachments && entry.attachments.length > 0) {
      for (const attachment of entry.attachments) {
        if (attachment.mime.startsWith('image/')) {
          const imageResponse = await fetch(attachment.url);
          if (imageResponse.ok) {
            const blob = await imageResponse.blob();
            images.push({
              blob,
              mime: attachment.mime
            });
          }
        }
      }
    }

    // Upload images first if present
    const imageRefs = [];
    if (images.length > 0) {
      for (const image of images) {
        const uploadResp = await this.uploadImage(image.blob, image.mime);
        if (uploadResp) {
          imageRefs.push(uploadResp);
        }
      }
    }

    // Create the post
    const postData = {
      repo: this.env.BLUESKY_USERNAME,
      collection: 'app.bsky.feed.post',
      record: {
        $type: 'app.bsky.feed.post',
        text: text,
        createdAt: new Date().toISOString(),
      }
    };

    // Add images if we have them
    if (imageRefs.length > 0) {
      postData.record.embed = {
        $type: 'app.bsky.embed.images',
        images: imageRefs
      };
    }

    const response = await fetch(`${this.apiUrl}com.atproto.repo.createRecord`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.accessJwt}`
      },
      body: JSON.stringify(postData)
    });

    if (!response.ok) {
      throw new Error('Failed to create post');
    }
  }

  async uploadImage(blob, mime) {
    const response = await fetch(`${this.apiUrl}com.atproto.repo.uploadBlob`, {
      method: 'POST',
      headers: {
        'Content-Type': mime,
        'Authorization': `Bearer ${this.accessJwt}`
      },
      body: blob
    });

    if (!response.ok) {
      return null;
    }

    const data = await response.json();
    return {
      alt: '',
      image: data.blob
    };
  }

  async getPostedMsgIds() {
    try {
      const state = await this.env.BLUESKY_SYNC_KV.get('posted_msgs');
      return state ? JSON.parse(state) : [];
    } catch (error) {
      console.error('Failed to get state:', error);
      return [];
    }
  }

  async savePostedMsgIds(msgIds) {
    try {
      await this.env.BLUESKY_SYNC_KV.put('posted_msgs', JSON.stringify(msgIds));
    } catch (error) {
      console.error('Failed to save state:', error);
    }
  }
}

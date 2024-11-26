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
      await this.login();
      const postedMsgIds = await this.getPostedMsgIds();
      const feed = await this.fetchJSONFeed();
      
      // Find new entries
      const newEntries = feed
        .filter(entry => !postedMsgIds.includes(entry.msgid))
        .sort((a, b) => a.timestamp - b.timestamp); // oldest first
      
      // Group entries that can be combined
      const groupedPosts = this.groupEntriesForPosting(newEntries);
      
      // Post each group
      for (const group of groupedPosts) {
        if (group.length === 1) {
          await this.postToBluesky(group[0]);
        } else {
          await this.postCombinedEntries(group);
        }
        
        // Update posted message IDs
        group.forEach(entry => postedMsgIds.push(entry.msgid));
      }
      
      // Trim old message IDs if needed
      if (postedMsgIds.length > 1000) {
        postedMsgIds.splice(0, postedMsgIds.length - 1000);
      }
      
      await this.savePostedMsgIds(postedMsgIds);
      return new Response(`Sync completed. Posted ${newEntries.length} entries in ${groupedPosts.length} posts.`, { status: 200 });
    } catch (error) {
      console.error('Sync failed:', error);
      return new Response(`Sync failed: ${error.message}`, { status: 500 });
    }
  }
  
  groupEntriesForPosting(entries) {
    const MAX_POST_LENGTH = 300; // Bluesky's character limit
    const TIME_WINDOW = 3600; // 1 hour in seconds
    const groups = [];
    let currentGroup = [];
    let currentLength = 0;
    
    for (const entry of entries) {
      const entryText = this.formatEntryText(entry);
      
      // Check if this entry can be combined with current group
      const canCombine = currentGroup.length > 0 &&
        Math.abs(entry.timestamp - currentGroup[currentGroup.length - 1].timestamp) <= TIME_WINDOW &&
        currentLength + entryText.length + 2 <= MAX_POST_LENGTH && // +2 for separator
        // Only combine if neither entry has attachments
        !entry.attachments?.length &&
        !currentGroup.some(e => e.attachments?.length);
      
      if (canCombine) {
        currentGroup.push(entry);
        currentLength += entryText.length + 2; // +2 for separator
      } else {
        if (currentGroup.length > 0) {
          groups.push(currentGroup);
        }
        currentGroup = [entry];
        currentLength = entryText.length;
      }
    }
    
    if (currentGroup.length > 0) {
      groups.push(currentGroup);
    }
    
    return groups;
  }
  
  formatEntryText(entry) {
    return entry.content.trim();
  }

  async postCombinedEntries(entries) {
    const combinedText = entries
      .map(entry => this.formatEntryText(entry))
      .join('\n\n');
    
    const postData = {
      repo: this.env.BLUESKY_USERNAME,
      collection: 'app.bsky.feed.post',
      record: {
        $type: 'app.bsky.feed.post',
        text: combinedText,
        createdAt: new Date().toISOString(),
      }
    };

    const response = await fetch(`${this.apiUrl}com.atproto.repo.createRecord`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.accessJwt}`
      },
      body: JSON.stringify(postData)
    });

    if (!response.ok) {
      throw new Error('Failed to create combined post');
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

  async uploadImage(imageUrl, mime) {
    try {
      console.log(`Downloading image from: ${imageUrl}`);
      
      const imageResponse = await fetch(imageUrl);
      if (!imageResponse.ok) {
        console.error(`Failed to download image: ${imageResponse.status}`);
        return null;
      }

      const imageArrayBuffer = await imageResponse.arrayBuffer();
      
      console.log(`Uploading image to Bluesky (${imageArrayBuffer.byteLength} bytes)`);
      
      const uploadResponse = await fetch(`${this.apiUrl}com.atproto.repo.uploadBlob`, {
        method: 'POST',
        headers: {
          'Content-Type': mime,
          'Authorization': `Bearer ${this.accessJwt}`
        },
        body: imageArrayBuffer
      });

      if (!uploadResponse.ok) {
        console.error(`Failed to upload image: ${uploadResponse.status}`);
        return null;
      }

      const result = await uploadResponse.json();
      console.log('Image upload successful, blob:', result.blob);

      return {
        alt: '',
        image: result.blob
      };
    } catch (error) {
      console.error('Error handling image:', error);
      return null;
    }
  }

  async postToBluesky(entry) {
    try {
      const text = entry.content || '';
      const imageRefs = [];

      // Handle attachments if present
      if (entry.attachments && entry.attachments.length > 0) {
        console.log(`Processing ${entry.attachments.length} attachments`);
        
        for (const attachment of entry.attachments) {
          if (attachment.mime.startsWith('image/')) {
            console.log(`Processing image: ${attachment.url}`);
            const imageRef = await this.uploadImage(attachment.url, attachment.mime);
            if (imageRef) {
              imageRefs.push(imageRef);
            }
          }
        }
      }

      const postData = {
        repo: this.env.BLUESKY_USERNAME,
        collection: 'app.bsky.feed.post',
        record: {
          $type: 'app.bsky.feed.post',
          text: text,
          createdAt: new Date().toISOString()
        }
      };

      if (imageRefs.length > 0) {
        console.log(`Attaching ${imageRefs.length} images to post`);
        postData.record.embed = {
          $type: 'app.bsky.embed.images',
          images: imageRefs
        };
      }

      console.log('Creating post with data:', JSON.stringify(postData, null, 2));

      const response = await fetch(`${this.apiUrl}com.atproto.repo.createRecord`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.accessJwt}`
        },
        body: JSON.stringify(postData)
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Failed to create post: ${errorText}`);
      }

      const result = await response.json();
      console.log('Post created successfully:', result);
      
    } catch (error) {
      console.error('Error creating post:', error);
      throw error;
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

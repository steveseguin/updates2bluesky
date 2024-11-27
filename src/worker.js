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
    this.MAX_POST_LENGTH = 300;
    this.COMBINE_WINDOW = 1000; // 16.67 minutes
  }
  
  formatText(content) {
    if (!content) return '';
    
    return content
      // Handle bullet points
      .replace(/^- /gm, '• ')
      // Handle bold text
      .replace(/\*\*(.*?)\*\*/g, '𝗯$1𝗯')
      // Handle arrows
      .replace(/->/g, '➜')
      // Clean up excessive newlines
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  shouldCombineMessages(entries) {
    if (entries.length < 2) return false;
    
    // Check if entries are within the time window
    const newest = entries[0].timestamp;
    const oldest = entries[entries.length - 1].timestamp;
    if (newest - oldest > this.COMBINE_WINDOW) return false;
    
    // Calculate combined length
    const combinedLength = entries.reduce((acc, entry) => 
      acc + (entry.content ? this.formatText(entry.content).length : 0), 0);
      
    return combinedLength <= this.MAX_POST_LENGTH;
  }

	async processFeed(sortedEntries) {
	  let currentBatch = [];
	  const processedMsgIds = new Set();
	  const postedMsgIds = await this.getPostedMsgIds();
	  
	  for (let i = 0; i < sortedEntries.length; i++) {
		const entry = sortedEntries[i];
		
		// Skip if already posted in previous runs
		if (postedMsgIds.includes(entry.msgid)) continue;
		
		// Skip if already processed in this run
		if (processedMsgIds.has(entry.msgid)) continue;
		
		currentBatch = [entry];
		
		// Look ahead for potential combinations
		while (i + 1 < sortedEntries.length) {
		  const nextEntry = sortedEntries[i + 1];
		  const potentialBatch = [...currentBatch, nextEntry];
		  
		  if (this.shouldCombineMessages(potentialBatch)) {
			currentBatch.push(nextEntry);
			processedMsgIds.add(nextEntry.msgid);
			i++;
		  } else {
			break;
		  }
		}
		
		// Create the post
		await this.createCombinedPost(currentBatch);
		
		// Update state after each successful post
		for (const processedEntry of currentBatch) {
		  processedMsgIds.add(processedEntry.msgid);
		  if (!postedMsgIds.includes(processedEntry.msgid)) {
			postedMsgIds.push(processedEntry.msgid);
			// Save state after each successful post
			await this.savePostedMsgIds(postedMsgIds);
		  }
		}
	  }
	}


  async createCombinedPost(entries) {
    // Combine text content
    const text = entries
      .map(entry => this.formatText(entry.content))
      .filter(Boolean)
      .join('\n\n');
      
    // Skip empty posts
    if (!text && !entries.some(e => e.attachments?.length > 0)) {
      return;
    }

    // Gather all images (up to 4, Bluesky's limit)
    const images = [];
    for (const entry of entries) {
      if (entry.attachments) {
        for (const attachment of entry.attachments) {
          if (attachment.mime.startsWith('image/') && images.length < 4) {
            const imageData = await this.fetchAndUploadImage(attachment.url);
            if (imageData) {
              images.push(imageData);
            }
          }
        }
      }
    }

    // Create post data
    const postData = {
      repo: this.env.BLUESKY_USERNAME,
      collection: 'app.bsky.feed.post',
      record: {
        $type: 'app.bsky.feed.post',
        text: text || "New update available",
        createdAt: new Date().toISOString(),
      }
    };

    // Add images if we have them
    if (images.length > 0) {
      postData.record.embed = {
        $type: 'app.bsky.embed.images',
        images: images
      };
    }

    // Post to Bluesky
    const response = await fetch(`${this.apiUrl}com.atproto.repo.createRecord`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.accessJwt}`
      },
      body: JSON.stringify(postData)
    });

    if (!response.ok) {
      throw new Error(`Failed to create post: ${await response.text()}`);
    }
  }

  async fetchAndUploadImage(url) {
    try {
      const imageResponse = await fetch(url);
      if (!imageResponse.ok) return null;

      const blob = await imageResponse.blob();
      
      const uploadResponse = await fetch(`${this.apiUrl}com.atproto.repo.uploadBlob`, {
        method: 'POST',
        headers: {
          'Content-Type': blob.type,
          'Authorization': `Bearer ${this.accessJwt}`
        },
        body: blob
      });

      if (!uploadResponse.ok) return null;

      const data = await uploadResponse.json();
      return {
        alt: 'Update image',
        image: data.blob
      };
    } catch (error) {
      console.error('Failed to fetch or upload image:', error);
      return null;
    }
  }
  
  async sync() {
    try {
		// Login to Bluesky
		await this.login();

		// Fetch current state from KV store
		const postedMsgIds = await this.getPostedMsgIds();

		// Fetch and parse JSON feed
		const feed = await this.fetchJSONFeed();

		// Sort entries by timestamp (newest first)
		const sortedEntries = feed.sort((a, b) => b.timestamp - a.timestamp);

		// Process new entries
		await this.processFeed(sortedEntries.filter(entry => !postedMsgIds.includes(entry.msgid)));

		// Update posted message IDs
		const allProcessedIds = sortedEntries
		  .filter(entry => !postedMsgIds.includes(entry.msgid))
		  .map(entry => entry.msgid);
		postedMsgIds.push(...allProcessedIds);

		// Keep only last 1000 message IDs
		if (postedMsgIds.length > 1000) {
		  postedMsgIds.splice(0, postedMsgIds.length - 1000);
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
	  const feed = await response.json();
	  
	  // Validate feed structure
	  if (!Array.isArray(feed)) {
		throw new Error('Feed must be an array');
	  }
	  
	  // Validate each entry has required fields
	  feed.forEach((entry, index) => {
		if (!entry.msgid) {
		  throw new Error(`Entry at index ${index} missing msgid`);
		}
		if (!entry.timestamp) {
		  throw new Error(`Entry at index ${index} missing timestamp`);
		}
		// Convert string timestamps to numbers if needed
		if (typeof entry.timestamp === 'string') {
		  entry.timestamp = new Date(entry.timestamp).getTime();
		}
	  });
	  
	  return feed;
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

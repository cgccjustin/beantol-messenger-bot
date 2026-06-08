/**
 * Fetch Messenger / Instagram display names via Meta Graph API.
 * Cached per sender to limit API calls.
 */

const CACHE_TTL_MS = Number(process.env.META_PROFILE_CACHE_HOURS || 24) * 60 * 60 * 1000;
const GRAPH_VERSION = "v19.0";
const { scopeKey, getActiveTenant } = require("./tenant-context");
const { getPageAccessToken } = require("./tenant-registry");

/** @type {Map<string, { name: string, at: number }>} */
const profileCache = new Map();

function formatProfileName(data, platform) {
  if (!data || data.error) return "";

  if (platform === "instagram") {
    const name = String(data.name || "").trim();
    if (name) return name;
    const username = String(data.username || "").trim();
    if (username) return username.startsWith("@") ? username : `@${username}`;
    return "";
  }

  const first = String(data.first_name || "").trim();
  const last = String(data.last_name || "").trim();
  const combined = [first, last].filter(Boolean).join(" ").trim();
  if (combined) return combined;

  return String(data.name || "").trim();
}

async function resolveCustomerDisplayName(senderId, platform = "messenger") {
  if (!senderId) return "";

  const cacheKey = `${scopeKey(senderId)}:${platform}`;
  const cached = profileCache.get(cacheKey);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return cached.name;
  }

  const token = getPageAccessToken(getActiveTenant());
  if (!token) return "";

  const fields =
    platform === "instagram" ? "name,username" : "first_name,last_name,name";
  const url =
    `https://graph.facebook.com/${GRAPH_VERSION}/${encodeURIComponent(senderId)}` +
    `?fields=${encodeURIComponent(fields)}&access_token=${encodeURIComponent(token)}`;

  try {
    const response = await fetch(url);
    const data = await response.json();

    if (!response.ok || data.error) {
      const msg = data.error?.message || `HTTP ${response.status}`;
      console.warn(`Meta profile lookup failed for ${senderId} (${platform}): ${msg}`);
      profileCache.set(cacheKey, { name: "", at: Date.now() });
      return "";
    }

    const name = formatProfileName(data, platform);
    profileCache.set(cacheKey, { name, at: Date.now() });
    if (name) {
      console.log(`Meta profile: ${senderId} (${platform}) → ${name}`);
    }
    return name;
  } catch (err) {
    console.warn(`Meta profile lookup error for ${senderId}:`, err.message);
    return "";
  }
}

module.exports = {
  resolveCustomerDisplayName,
  formatProfileName,
};

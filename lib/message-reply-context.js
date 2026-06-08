const TTL_MS =
  Number(process.env.OUTBOUND_MID_TTL_HOURS || 168) * 60 * 60 * 1000;
const MAX_PER_RECIPIENT = Number(process.env.OUTBOUND_MID_MAX_PER_USER || 80);
const { scopeKey } = require("./tenant-context");

/** @type {Map<string, { recipientId: string, mid: string, content: string, tags: string[], sentAt: number }>} */
const byMid = new Map();
/** @type {Map<string, string[]>} recipientId -> mids (oldest first) */
const midsByRecipient = new Map();

function classifyOutboundMessage(text) {
  const t = String(text || "").trim();
  const tags = [];
  if (!t) return tags;

  if (/Quote summary\s*—\s*please confirm:/i.test(t)) tags.push("quote_confirm");
  if (/Reply YES to get your printable formal quote link/i.test(t)) tags.push("quote_confirm");
  if (/How would you like to proceed\?/i.test(t)) tags.push("post_quote_fulfillment");
  if (/reply pickup or delivery/i.test(t)) tags.push("post_quote_fulfillment");
  if (/^Great — pickup at our shop:/i.test(t)) tags.push("post_quote_pickup");
  if (/Reply \*\*OK\*\* when you've noted the pickup|reply \*\*OK\*\* to confirm pickup/i.test(t)) {
    tags.push("post_quote_pickup_confirm");
  }
  if (/^Delivery via Maxim — please send all three/i.test(t)) {
    tags.push("post_quote_delivery_collect");
  }
  if (
    /\bthanks for (?:the )?details\b/i.test(t) &&
    /\b(?:payment|pay).*(?:before|first|prior|settled|settle)/i.test(t) &&
    /\bmaxim\b/i.test(t)
  ) {
    tags.push("delivery_details_confirm");
  }
  if (
    /Prefer to chat with a real person/i.test(t) ||
    /Reply YES anytime if you'd like to chat with a sales rep/i.test(t) ||
    /If you'd like to connect with our customer representative/i.test(t) ||
    /(?:reply|type)\s+YES.*(?:agent|representative|sales rep|real person|live staff)/i.test(t) ||
    (/(?:agent|representative|sales rep|real person|live staff)/i.test(t) &&
      /(?:reply|type)\s+yes/i.test(t))
  ) {
    tags.push("agent_offer");
  }
  if (/^Got it — I am connecting you with our team/i.test(t)) tags.push("handoff_ack");

  return [...new Set(tags)];
}

function pruneRecipient(recipientId) {
  const list = midsByRecipient.get(recipientId);
  if (!list) return;
  const now = Date.now();
  while (list.length > 0) {
    const oldest = list[0];
    const entry = byMid.get(oldest);
    if (!entry || now - entry.sentAt > TTL_MS) {
      list.shift();
      if (entry) byMid.delete(oldest);
      continue;
    }
    break;
  }
  while (list.length > MAX_PER_RECIPIENT) {
    const drop = list.shift();
    if (drop) byMid.delete(drop);
  }
  if (list.length === 0) midsByRecipient.delete(recipientId);
}

function recordOutboundMessage(recipientId, mid, content) {
  const rid = scopeKey(String(recipientId || "").trim());
  const messageId = String(mid || "").trim();
  const text = String(content || "").trim();
  if (!rid || !messageId || !text) return;

  const entry = {
    recipientId: rid,
    mid: messageId,
    content: text,
    tags: classifyOutboundMessage(text),
    sentAt: Date.now(),
  };
  byMid.set(messageId, entry);

  let list = midsByRecipient.get(rid);
  if (!list) {
    list = [];
    midsByRecipient.set(rid, list);
  }
  const existingIdx = list.indexOf(messageId);
  if (existingIdx >= 0) list.splice(existingIdx, 1);
  list.push(messageId);
  pruneRecipient(rid);
}

function extractReplyToMid(event) {
  const mid = event?.message?.reply_to?.mid;
  return mid ? String(mid) : "";
}

/**
 * @returns {{ mid: string, content: string, tags: string[] } | null}
 */
function resolveInboundReplyTo(recipientId, event) {
  const messageId = extractReplyToMid(event);
  if (!messageId) return null;

  const entry = byMid.get(messageId);
  if (!entry) return null;
  if (entry.recipientId !== scopeKey(String(recipientId))) return null;
  if (Date.now() - entry.sentAt > TTL_MS) {
    byMid.delete(messageId);
    return null;
  }

  return {
    mid: entry.mid,
    content: entry.content,
    tags: entry.tags,
  };
}

function hasReplyTag(replyContext, tag) {
  return Boolean(replyContext?.tags?.includes(tag));
}

function assistantOfferedLiveAgent(text) {
  return classifyOutboundMessage(text).includes("agent_offer");
}

function isAffirmativeYes(text) {
  const t = String(text || "").trim();
  if (!t || t.length > 48) return false;
  return (
    /^(?:yes|oo|yep|oo po|yes po|yes please|oo please|oo,?\s*please|yes,?\s*please)(?:[!.?]|$)/i.test(
      t
    ) || (/^yes\b/i.test(t) && t.length <= 24)
  );
}

/**
 * Customer said YES (or similar) in response to a live-agent offer — not a quote confirm.
 */
function isAgentOfferAcceptanceTurn(userText, assistantReply = "", replyToContext = null) {
  if (!isAffirmativeYes(userText)) return false;
  if (hasReplyTag(replyToContext, "quote_confirm")) return false;
  if (hasReplyTag(replyToContext, "agent_offer")) return true;
  if (assistantOfferedLiveAgent(assistantReply)) return true;
  return false;
}

module.exports = {
  classifyOutboundMessage,
  recordOutboundMessage,
  extractReplyToMid,
  resolveInboundReplyTo,
  hasReplyTag,
  assistantOfferedLiveAgent,
  isAgentOfferAcceptanceTurn,
};

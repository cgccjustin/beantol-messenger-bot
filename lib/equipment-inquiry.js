const { businessName } = require("./tenant-messages");
const { getActiveTenant } = require("./tenant-context");

const EQUIPMENT_TERMS =
  /\b(?:espresso\s+machine|coffee\s+machine|coffee\s+maker|french\s+press|aeropress|moka\s+pot|coffee\s+grinder|burr\s+grinder|grinder|brewer|gooseneck\s+kettle|kettle|v60|chemex|dripper|pour[\s-]?over\s+(?:device|setup|equipment)|coffee\s+equipment|brewing\s+equipment|coffee\s+gear|tamper|portafilter)\b/i;

const EQUIPMENT_SALES_INTENT =
  /\b(?:do you sell|sell\s+(?:any|a|the)?|benta|presyo|magkano|how much|price|cost|available|in stock|do you have|you have|have you got|carry|offer)\b/i;

/** Customer wants to buy gear from us — not asking which beans for their existing brewer. */
function isEquipmentSalesInquiry(text) {
  const t = String(text || "").trim();
  if (!t || !EQUIPMENT_TERMS.test(t)) return false;

  if (
    /\b(?:i have|i've got|i own|i am using|i'm using|gamit ko|naa ko|using my|with my|for my|what beans|which beans|unsay beans|recommend.*beans)\b/i.test(
      t
    )
  ) {
    return false;
  }

  if (EQUIPMENT_SALES_INTENT.test(t)) return true;

  if (
    /\b(?:looking for|need|want|hanap|gusto|recommend|suggest).*(?:machine|grinder|press|equipment|brewer|gear)\b/i.test(
      t
    )
  ) {
    return true;
  }

  if (
    /\b(?:machine|grinder|equipment|brewer|gear).*(?:looking for|need|want|recommend|suggest|buy|order)\b/i.test(
      t
    )
  ) {
    return true;
  }

  // "french press" / "aeropress" alone with purchase phrasing — not bare "press" (french press ownership)
  if (
    /\b(?:french press|aeropress|chemex|v60|espresso machine|coffee machine|moka pot|coffee grinder)\b/i.test(
      t
    ) &&
    /\?/.test(t)
  ) {
    return true;
  }

  return false;
}

function isCafeTenant() {
  const tenant = getActiveTenant();
  return tenant?.rules?.profile === "cafe";
}

function buildEquipmentSalesReply() {
  const name = businessName();
  if (isCafeTenant()) {
    return [
      `Thanks for asking! ${name} is a café — we don't sell coffee machines, French presses, grinders, or other brewing equipment.`,
      "",
      "We serve drinks and food from our menu. If you'd like to order for pickup or have questions about what we offer, I'm happy to help.",
      "",
      "What would you like to know about our menu?",
    ].join("\n");
  }

  return [
    `Thanks for asking! ${name} sells roasted coffee beans only — we don't sell espresso machines, French presses, grinders, kettles, or other brewing equipment.`,
    "",
    "If you tell me how you brew at home (espresso machine, pour-over, French press, etc.), I can help you pick the right beans and sizes.",
    "",
    "Would you like a bean recommendation?",
  ].join("\n");
}

function getEquipmentSalesSystemNote() {
  if (isCafeTenant()) {
    return (
      "COFFEE EQUIPMENT (strict):\n" +
      "- This shop does NOT sell coffee machines, French presses, grinders, or brewing equipment.\n" +
      "- If the customer asks to buy equipment, say so politely and redirect to menu drinks/food from KNOWLEDGE CONTEXT.\n" +
      "- If they already own equipment and ask which beans to use, help with beans/menu — do NOT refuse those questions."
    );
  }

  return (
    "COFFEE EQUIPMENT (strict):\n" +
    "- Beantol sells roasted coffee beans only — NOT espresso machines, French presses, grinders, kettles, drippers, or other brewing gear.\n" +
    "- If the customer asks to buy, order, or get a price for equipment: say we sell beans only; offer to help pick beans for their brew method.\n" +
    "- Do NOT invent equipment brands, prices, or retailers.\n" +
    "- If they already own a machine/French press/etc. and ask which beans to use, help with bean recommendations — do NOT treat that as an equipment sale."
  );
}

function resolveEquipmentSalesTurn(userText) {
  if (!isEquipmentSalesInquiry(userText)) return { handled: false };
  return { handled: true, reply: buildEquipmentSalesReply() };
}

module.exports = {
  isEquipmentSalesInquiry,
  buildEquipmentSalesReply,
  getEquipmentSalesSystemNote,
  resolveEquipmentSalesTurn,
};

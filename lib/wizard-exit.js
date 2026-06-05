const { ORDER_INTENT_PATTERN } = require("./lead-capture");
const { matchCatalogFromText } = require("./catalog");

const SKIP_WIZARD_PATTERN =
  /\b(?:never mind|nevermind|skip|cancel wizard|stop asking|already know|just (?:order|buy|get)|forget it)\b/i;

const RECOMMEND_INTENT =
  /\b(?:recommend|suggest|help me choose|what should i (?:get|buy)|best for|which (?:bean|coffee)|help me pick)\b/i;

/**
 * Customer wants to leave a 1-2-3 wizard and talk normally (order, named bean, etc.).
 */
function wantsToSkipWizardForOrderOrProduct(text) {
  const t = String(text || "").trim();
  if (!t) return false;

  if (ORDER_INTENT_PATTERN.test(t)) return true;
  if (matchCatalogFromText(t)) return true;
  if (SKIP_WIZARD_PATTERN.test(t)) return true;

  const hasSize = /\b(?:250g|500g|1kg|6\s*kg)\b/i.test(t);
  const hasProductHint =
    /\b(?:prime|cerrado|santos|guji|sidama|kenya|apo|ellaga|beantol|brazil|ethiopia)\b/i.test(t);
  if (hasSize && hasProductHint) return true;

  return false;
}

function wantsToSkipAppointmentWizard(text) {
  if (wantsToSkipWizardForOrderOrProduct(text)) return true;
  if (RECOMMEND_INTENT.test(String(text || ""))) return true;
  return false;
}

module.exports = {
  wantsToSkipWizardForOrderOrProduct,
  wantsToSkipAppointmentWizard,
};

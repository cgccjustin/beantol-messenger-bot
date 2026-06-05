const { google } = require("googleapis");

function getGoogleAuth(scopes) {
  const scopeList = Array.isArray(scopes) ? scopes : [scopes];

  if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
    return new google.auth.GoogleAuth({
      credentials,
      scopes: scopeList,
    });
  }

  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    return new google.auth.GoogleAuth({
      keyFile: process.env.GOOGLE_APPLICATION_CREDENTIALS,
      scopes: scopeList,
    });
  }

  throw new Error(
    "Set GOOGLE_SERVICE_ACCOUNT_JSON (Render) or GOOGLE_APPLICATION_CREDENTIALS (local file path)."
  );
}

function hasGoogleCredentials() {
  return Boolean(
    process.env.GOOGLE_SERVICE_ACCOUNT_JSON || process.env.GOOGLE_APPLICATION_CREDENTIALS
  );
}

module.exports = { getGoogleAuth, hasGoogleCredentials };

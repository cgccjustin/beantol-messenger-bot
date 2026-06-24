const { JWT } = require("google-auth-library");
const { getGoogleHttpsTransporter } = require("./google-https-transport");

function getGoogleAuth(scopes) {
  const scopeList = Array.isArray(scopes) ? scopes : [scopes];
  const transporter = getGoogleHttpsTransporter();

  if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
    return new JWT({
      email: credentials.client_email,
      key: credentials.private_key,
      scopes: scopeList,
      transporter,
    });
  }

  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    return new JWT({
      keyFile: process.env.GOOGLE_APPLICATION_CREDENTIALS,
      scopes: scopeList,
      transporter,
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

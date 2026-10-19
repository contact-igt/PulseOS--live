import "dotenv/config";
import { db, queryClient } from "../db/client.js";
import { checkSecretsDecryptable, findOpenWebsiteIntakes } from "../domain/integration/website-intake-audit.js";

// Read-only operator check (pnpm audit:website-intake). Run it against the target environment BEFORE rolling the API back to a
// release that ignores `requireToken`, and after any deploy to confirm CONNECTOR_ENCRYPTION_KEY still opens every stored secret.
// Prints identifiers and kinds only, never a secret. Exit code 1 means something needs attention.
const open = await findOpenWebsiteIntakes(db);
const secrets = await checkSecretsDecryptable(db);
console.log(JSON.stringify({ openWebsiteIntakes: open, secrets: { total: secrets.total, ok: secrets.ok, failed: secrets.failed } }, null, 2));
await queryClient.end();
process.exit(open.length > 0 || secrets.failed.length > 0 ? 1 : 0);

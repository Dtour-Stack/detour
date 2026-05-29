import { VaultService } from "../src/bun/core/vault";

async function main() {
  const service = new VaultService();
  const v = await service.vault();
  const exists = await v.has("config.character");
  console.log("config.character exists in vault:", exists);
  if (exists) {
    const raw = await v.get("config.character");
    console.log("Raw config.character:");
    console.log(raw);
  }
}

main().catch(console.error);

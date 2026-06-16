import "dotenv/config";

// Fires a single trigger-read call and exits immediately - no waiting, no
// listening. Run `npm run listen` in a separate terminal first, then run
// this, and watch how long it actually takes for a payload to show up in
// the listener. This measures real end-to-end latency (trigger -> Svix ->
// your webhook) without our adapter's short 8s cutoff getting in the way.

async function main() {
  const apiKey = process.env.AMPERSAND_API_KEY;
  const projectId = process.env.AMPERSAND_PROJECT_ID;
  const integrationId = process.env.AMPERSAND_INTEGRATION_ID;
  const groupRef = process.env.AMPERSAND_GROUP_REF;

  if (!apiKey || !projectId || !integrationId || !groupRef) {
    console.error("Set AMPERSAND_API_KEY, AMPERSAND_PROJECT_ID, AMPERSAND_INTEGRATION_ID, AMPERSAND_GROUP_REF in .env first.");
    process.exit(1);
  }

  const triggeredAt = Date.now();
  const res = await fetch(
    `https://read.withampersand.com/v1/projects/${projectId}/integrations/${integrationId}/objects/issues`,
    {
      method: "POST",
      headers: { "X-Api-Key": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({ groupRef, mode: "async" }),
    }
  );

  if (!res.ok) {
    console.error(`Failed: ${res.status} ${await res.text()}`);
    process.exit(1);
  }

  const { operationId } = await res.json() as any;
  console.log(`Triggered at ${new Date(triggeredAt).toISOString()}, operationId: ${operationId}`);
  console.log(`Watch the npm run listen terminal - note the timestamp when a payload arrives,`);
  console.log(`and compare it to the trigger time above to see real delivery latency.`);
}

main();

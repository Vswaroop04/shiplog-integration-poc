import "dotenv/config";

// OAuth-connect (scripts/connect.ts) only creates the underlying connection.
// You also need to explicitly "install" the integration for that groupRef -
// this attaches the read config (which objects, what schedule) from
// amp.yaml to the connection. Without this, trigger-read fails with
// "error finding installations: record not found" even though the OAuth
// connection itself succeeded.

async function main() {
  const apiKey = process.env.AMPERSAND_API_KEY;
  const projectId = process.env.AMPERSAND_PROJECT_ID;
  const integrationId = process.env.AMPERSAND_INTEGRATION_ID;
  const groupRef = process.env.AMPERSAND_GROUP_REF || "my-test-account";

  if (!apiKey || !projectId || !integrationId) {
    console.error("Set AMPERSAND_API_KEY, AMPERSAND_PROJECT_ID, AMPERSAND_INTEGRATION_ID in .env first.");
    process.exit(1);
  }

  const res = await fetch(
    `https://api.withampersand.com/v1/projects/${projectId}/integrations/${integrationId}/installations`,
    {
      method: "POST",
      headers: { "X-Api-Key": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({
        groupRef,
        // connectionId omitted - falls back to this group's default connection,
        // i.e. the one created by scripts/connect.ts
        config: {
          content: {
            provider: "github",
            read: {
              objects: {
                issues: {
                  objectName: "issues",
                  schedule: "*/30 * * * *",
                },
              },
            },
          },
        },
      }),
    }
  );

  if (!res.ok) {
    console.error(`Failed: ${res.status} ${await res.text()}`);
    process.exit(1);
  }

  console.log("Installation created:", await res.text());
  console.log(`\nThis integration is now installed for groupRef "${groupRef}" - trigger-read should work now.`);
}

main();

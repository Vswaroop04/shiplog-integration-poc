import "dotenv/config";

// Generates an OAuth authorization URL for connecting a GitHub account to
// Ampersand, without needing to build any frontend/React UI. Run this once,
// open the printed URL, authorize your GitHub account, and the groupRef
// below becomes a real, usable connection.

async function main() {
  const apiKey = process.env.AMPERSAND_API_KEY;
  const projectId = process.env.AMPERSAND_PROJECT_ID;
  // `??` only falls back on null/undefined - an empty string from
  // AMPERSAND_GROUP_REF= in .env still passes through as "", so use `||`
  const groupRef = process.env.AMPERSAND_GROUP_REF || "my-test-account";

  if (!apiKey || !projectId) {
    console.error("Set AMPERSAND_API_KEY and AMPERSAND_PROJECT_ID in .env first.");
    process.exit(1);
  }

  const res = await fetch("https://api.withampersand.com/v1/oauth-connect", {
    method: "POST",
    headers: { "X-Api-Key": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({
      projectIdOrName: projectId,
      provider: "github",
      groupRef,
      consumerRef: "me",
    }),
  });

  if (!res.ok) {
    console.error(`Failed: ${res.status} ${await res.text()}`);
    process.exit(1);
  }

  const url = await res.text();
  console.log(`\nOpen this URL in your browser to authorize GitHub:\n\n${url}\n`);
  console.log(`Once you authorize, AMPERSAND_GROUP_REF should be set to: "${groupRef}"`);
}

main();

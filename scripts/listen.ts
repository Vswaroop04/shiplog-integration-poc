import http from "http";

// Standalone webhook listener - run this and leave it running while you
// register the ngrok URL as a destination in Ampersand's dashboard, and
// while you manually trigger test reads. Logs whatever arrives so you can
// see the actual payload shape before relying on the adapter's guess of
// `payload.records ?? payload.data`.

const port = Number(process.env.AMPERSAND_WEBHOOK_PORT ?? 4242);

const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", chunk => (body += chunk));
  req.on("end", () => {
    console.log(`\n--- ${new Date().toISOString()} ${req.method} ${req.url} ---`);
    try {
      console.log(JSON.stringify(JSON.parse(body), null, 2));
    } catch {
      console.log("(not JSON) raw body:", body);
    }
    res.writeHead(200);
    res.end("ok");
  });
});

server.listen(port, () => {
  console.log(`Listening on http://localhost:${port} - point ngrok at this port and leave it running.`);
});

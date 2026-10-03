// Local runner: serves the fetch handler on http://localhost:$PORT (Compute does this itself).
import { createServer } from "node:http";
import app from "./index.mjs";

const port = Number(process.env.PORT ?? 4100);
createServer(async (req, res) => {
  const body = ["GET", "HEAD"].includes(req.method) ? undefined : req;
  const request = new Request(`http://localhost:${port}${req.url}`, {
    method: req.method, headers: req.headers, body, duplex: "half",
  });
  const response = await app.fetch(request);
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(Buffer.from(await response.arrayBuffer()));
}).listen(port, () => console.log(`clinic on http://localhost:${port}`));

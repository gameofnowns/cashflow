import { createServer } from "node:https";
import { readFileSync } from "node:fs";
import { parse } from "node:url";
import next from "next";

const dev = process.env.NODE_ENV !== "production";
const app = next({ dev });
const handle = app.getRequestHandler();

const httpsOptions = {
  key: readFileSync("./certs/localhost-key.pem"),
  cert: readFileSync("./certs/localhost.pem"),
};

app.prepare().then(() => {
  createServer(httpsOptions, (req, res) => {
    const parsedUrl = parse(req.url, true);
    handle(req, res, parsedUrl);
  }).listen(3000, () => {
    console.log("> HTTPS server ready on https://localhost:3000");
  });
});

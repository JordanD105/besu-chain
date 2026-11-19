// Static file server for the self-hosted Remix IDE (no dependencies). Serves ./site, compressed
// with gzip when the browser accepts it (the Remix bundles are large).
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const ROOT = path.join(__dirname, "site");
const PORT = Number(process.env.PORT) || 30200;
const TYPES = {
    ".html": "text/html; charset=utf-8", ".js": "application/javascript; charset=utf-8",
    ".mjs": "application/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8", ".wasm": "application/wasm", ".svg": "image/svg+xml",
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
    ".ico": "image/x-icon", ".webp": "image/webp", ".woff": "font/woff", ".woff2": "font/woff2",
    ".ttf": "font/ttf", ".eot": "application/vnd.ms-fontobject", ".otf": "font/otf",
    ".mp3": "audio/mpeg", ".wav": "audio/wav", ".txt": "text/plain; charset=utf-8",
    ".map": "application/json; charset=utf-8", ".xml": "application/xml", ".md": "text/markdown; charset=utf-8"
};
const COMPRESS = /^(text\/|application\/(javascript|json|xml|wasm)|image\/svg)/;

http.createServer((req, res) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
        res.writeHead(405).end();
        return;
    }
    let rel;
    try {
        rel = decodeURIComponent(new URL(req.url, "http://x").pathname);
    } catch {
        res.writeHead(400).end();
        return;
    }
    let file = path.join(ROOT, path.normalize(rel));
    if (!file.startsWith(ROOT)) {
        res.writeHead(403).end();
        return;
    }
    fs.stat(file, (err, st) => {
        if (!err && st.isDirectory()) {
            file = path.join(file, "index.html");
        } else if (err) {
            file = path.join(ROOT, "index.html"); // single-page app routes
        }
        fs.stat(file, (err2, st2) => {
            if (err2 || !st2.isFile()) {
                res.writeHead(404).end();
                return;
            }
            const type = TYPES[path.extname(file).toLowerCase()] || "application/octet-stream";
            const headers = {
                "Content-Type": type,
                "Cache-Control": path.basename(file) === "index.html" || file.endsWith("list.json") ? "no-cache" : "public, max-age=3600",
                "Last-Modified": st2.mtime.toUTCString(),
                "X-Content-Type-Options": "nosniff"
            };
            if (req.headers["if-modified-since"] && new Date(req.headers["if-modified-since"]) >= new Date(st2.mtime.toUTCString())) {
                res.writeHead(304, headers).end();
                return;
            }
            const gzip = COMPRESS.test(type) && /\bgzip\b/.test(req.headers["accept-encoding"] || "") && st2.size > 1024;
            if (gzip) {
                headers["Content-Encoding"] = "gzip";
                headers.Vary = "Accept-Encoding";
            } else {
                headers["Content-Length"] = st2.size;
            }
            res.writeHead(200, headers);
            if (req.method === "HEAD") {
                res.end();
                return;
            }
            const stream = fs.createReadStream(file);
            (gzip ? stream.pipe(zlib.createGzip({ level: 6 })) : stream).pipe(res);
        });
    });
}).listen(PORT, "0.0.0.0", () => console.log(`Remix IDE on :${PORT}`));

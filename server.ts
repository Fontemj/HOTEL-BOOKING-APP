import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import { spawn, ChildProcess } from "child_process";

const app = express();
const PORT = 3000;
const PYTHON_PORT = 8001;

// Parse JSON request bodies
app.use(express.json());

// Spawn Python backend process
let pyProcess: ChildProcess | null = null;
let isShuttingDown = false;

function startPythonBackend() {
  const backendScript = path.join(process.cwd(), "backend", "server.py");
  console.log(`Starting Python SQL backend: python3 ${backendScript} ${PYTHON_PORT}`);

  pyProcess = spawn("python3", [backendScript, String(PYTHON_PORT)], {
    stdio: "inherit",
    cwd: process.cwd(),
  });

  pyProcess.on("error", (err) => {
    console.error("Failed to spawn Python backend process:", err);
  });

  pyProcess.on("exit", (code, signal) => {
    console.log(`Python backend process exited with code ${code}, signal ${signal}`);
    if (!isShuttingDown) {
      setTimeout(() => {
        console.log("Restarting Python backend process...");
        startPythonBackend();
      }, 1000);
    }
  });
}

process.on("exit", () => {
  isShuttingDown = true;
  if (pyProcess) {
    try {
      pyProcess.kill();
    } catch {}
  }
});

process.on("SIGINT", () => {
  isShuttingDown = true;
  if (pyProcess) pyProcess.kill();
  process.exit();
});

process.on("SIGTERM", () => {
  isShuttingDown = true;
  if (pyProcess) pyProcess.kill();
  process.exit();
});

startPythonBackend();

// Hop-by-hop and connection-specific headers that cannot be forwarded in fetch()
const DISALLOWED_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-connection",
  "transfer-encoding",
  "te",
  "trailer",
  "upgrade",
  "content-length",
  "host",
]);

// Reverse proxy API routes to Python HTTP server
app.all("/api/*", async (req, res) => {
  const targetUrl = `http://127.0.0.1:${PYTHON_PORT}${req.originalUrl}`;
  try {
    const headers: Record<string, string> = {};
    for (const [key, val] of Object.entries(req.headers)) {
      const lower = key.toLowerCase();
      if (!DISALLOWED_HEADERS.has(lower)) {
        if (typeof val === "string") {
          headers[key] = val;
        } else if (Array.isArray(val)) {
          headers[key] = val.join("; ");
        }
      }
    }

    const fetchOptions: RequestInit = {
      method: req.method,
      headers,
    };

    if (req.method !== "GET" && req.method !== "HEAD") {
      if (req.body && typeof req.body === "object" && Object.keys(req.body).length > 0) {
        fetchOptions.body = JSON.stringify(req.body);
        headers["content-type"] = "application/json";
      } else if (typeof req.body === "string" && req.body.length > 0) {
        fetchOptions.body = req.body;
      }
    }

    let pyRes: Response | null = null;
    let lastError: any = null;

    // Retry up to 3 times if Python server is initializing
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        pyRes = await fetch(targetUrl, fetchOptions);
        break;
      } catch (err: any) {
        lastError = err;
        if (attempt < 2) {
          await new Promise((r) => setTimeout(r, 200));
        }
      }
    }

    if (!pyRes) {
      throw lastError;
    }

    res.status(pyRes.status);
    pyRes.headers.forEach((val, key) => {
      const lower = key.toLowerCase();
      if (
        !DISALLOWED_HEADERS.has(lower) &&
        lower !== "content-encoding" &&
        lower !== "content-length"
      ) {
        res.setHeader(key, val);
      }
    });

    const getSetCookie = (pyRes.headers as any).getSetCookie;
    if (typeof getSetCookie === "function") {
      const cookies = getSetCookie.call(pyRes.headers);
      if (Array.isArray(cookies) && cookies.length > 0) {
        res.setHeader("set-cookie", cookies);
      }
    }

    const data = await pyRes.text();
    res.send(data);
  } catch (err: any) {
    console.error("Error proxying request to Python backend:", err);
    res.status(502).json({
      error: "Python SQL backend connecting...",
      details: err.message,
    });
  }
});

async function startServer() {
  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`WDC Grand Heritage app running on http://0.0.0.0:${PORT}`);
  });
}

startServer();

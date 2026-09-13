// pm2 config for the poker backend — the g2 always-on instance.
//
//   npm run dev        # start in watch mode, tail logs
//   npm run dev:stop   # stop the app
//   npm run dev:logs   # tail logs again without restarting
//
// The systemd keeper (systemd/poker.service → scripts/pm2-start.sh) starts
// exactly this file; pm2 state stays project-local (<repo>/.pm2).
//
// PORT is pinned to 64100 — the only port the Cloudflare tunnel forwards to
// (ingress poker.imre.dev → http://localhost:64100). It is deliberately
// outside the test band 5000-5899 and the fleet pool 13000-30242, and clear of
// earthandfire's 64000/64001. DATA_DIR is the repo-local data/ (gitignored).
const path = require("node:path");

module.exports = {
  apps: [
    {
      name: "poker",
      script: "server.ts",
      interpreter: "node",
      cwd: __dirname,
      // instances: 1 IS MANDATORY: live room/vote state lives in the server's
      // memory, so a second instance would serve a different world (split
      // presence, votes, and room lists). Never raise this. fork mode is
      // explicit for the same reason — no cluster workers.
      instances: 1,
      exec_mode: "fork",
      env: {
        PORT: "64100",
        DATA_DIR: path.join(__dirname, "data"),
      },
      watch: ["server.ts", "lib"],
      ignore_watch: [
        "node_modules",
        "data",
        ".pm2",
        ".pw-browsers",
        ".cloudflared",
      ],
      watch_options: {
        followSymlinks: false,
      },
      // Restart on crash, but never loop forever if it can't boot.
      autorestart: true,
      max_restarts: 10,
      min_uptime: "3s",
    },
  ],
};

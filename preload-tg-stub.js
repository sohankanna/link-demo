// Test-only preload stub (loaded via `node -r ./preload-tg-stub.js server.js`).
// Rewrites every https://api.telegram.org/bot* call to a local fake Telegram
// server (http://127.0.0.1:3399/bot*) so smoke tests never touch the real bot.
// The path suffix (/bot<token>/<method>) is preserved untouched.
const REAL = "https://api.telegram.org";
const FAKE = "http://127.0.0.1:3399";
const origFetch = globalThis.fetch;
if (typeof origFetch !== "function") {
  console.error("[preload-tg-stub] no global fetch to wrap — aborting");
  process.exit(1);
}
globalThis.fetch = function (input, init) {
  if (typeof input === "string" && input.startsWith(REAL)) {
    return origFetch.call(globalThis, FAKE + input.slice(REAL.length), init);
  }
  return origFetch.call(globalThis, input, init);
};

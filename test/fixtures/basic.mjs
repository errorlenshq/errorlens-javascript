import * as ErrorLens from "@errorlenshq/node";

ErrorLens.init({ release: "app@1.2.3", environment: "test", enableLogs: true, sendDefaultPii: false });
ErrorLens.setUser({ id: 7, email: "a@example.com" });
ErrorLens.setTag("region", "eu");
ErrorLens.setExtra("config", { password: "hunter2", apiKey: "abc", ok: true });
ErrorLens.addBreadcrumb({ category: "auth", message: "signed in" });
console.warn("cache miss for", { key: "orders" });

function loadOrder(id) {
  const password = "hunter2"; // must never leave the machine
  try {
    JSON.parse("{bad json");
  } catch (cause) {
    throw new Error(`Could not load order ${id} with token=sk_live_abcdefghijklmnop1234`, { cause });
  }
}

try {
  loadOrder(42);
} catch (e) {
  ErrorLens.captureException(e);
}
ErrorLens.captureMessage("hello from tests", "warning");
ErrorLens.withScope((scope) => {
  scope.setTag("scoped", "yes");
  ErrorLens.captureMessage("scoped message");
});
ErrorLens.logger.info("Order {orderId} paid by {user}", { orderId: 42, user: "bob", password: "x" });
await ErrorLens.withMonitor("nightly", async () => { await new Promise((r) => setTimeout(r, 30)); },
  { schedule: { type: "crontab", value: "0 2 * * *" }, maxRuntime: 30 });
await ErrorLens.startSpan({ name: "batch job", op: "task" }, async () => {
  await ErrorLens.startSpan({ name: "step one", op: "function" }, () => new Promise((r) => setTimeout(r, 10)));
});
console.log("flushed", await ErrorLens.flush(5000));

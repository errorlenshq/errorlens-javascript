import * as ErrorLens from "@errorlenshq/node";
ErrorLens.init({ tracesSampleRate: 1 });
const handler = ErrorLens.wrapHandler(async function orders(event) {
  ErrorLens.setTag("invocation", event.id);
  if (event.fail) throw new Error("lambda failed");
  return { ok: true };
});
await handler({ id: "1" });
await handler({ id: "2", fail: true }).catch(() => {});
// Events sent before the handler returned, no flush needed here.
process.exit(0);
